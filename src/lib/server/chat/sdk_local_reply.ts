import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	generateId,
	streamText,
	type ToolSet,
	type UIMessage
} from 'ai';
import type { PreparedStreamContext } from '$lib/server/chat/stream_prepare';
import type { LanguageModel } from 'ai';
import { streamViaClaudeCLI } from '$lib/server/claude_cli_stream';
import { persistAssistantTurn } from '$lib/server/chat_turn';
import { upsertThreadTier } from '$lib/server/thread_state';
import { touchLastActivity } from '$lib/server/thread_meta';
import { logEscalation, updateEscalationCloudOutput } from '$lib/server/escalation_log';
import { preTurnRoute } from '$lib/server/routing/pre_turn_router';
import { LOCAL_GATE_INSTRUCTION, parseEscalation } from '$lib/server/routing/local_gate';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import {
	finishWithReplyId,
	rollbackOrphanTurn,
	emitRoutingFrame,
	type SullyRoutingFrame
} from '$lib/server/chat/sdk_stream_common';
import {
	classifySullyError,
	emitSullyError,
	type SullyErrorWriter
} from '$lib/server/chat/sdk_direct_reply';

function transcriptFrom(modelMessages: UIMessage[]): string {
	return modelMessages
		.map((m) => {
			const role = m.role === 'assistant' ? 'assistant' : 'user';
			const text = (m.parts || [])
				.filter((p) => p.type === 'text')
				.map((p) => (p as { type: 'text'; text: string }).text)
				.join('');
			return text ? `[${role}]: ${text}` : '';
		})
		.filter(Boolean)
		.join('\n\n');
}

export function handleLocalReply(opts: {
	ctx: PreparedStreamContext;
	request: Request;
	model: LanguageModel;
	tools: ToolSet;
	routing?: SullyRoutingFrame;
}): Response {
	const { ctx, request, model, tools, routing } = opts;
	const decision = ctx.shadowDecision;
	const escalationModel = process.env.COMPANION_ESCALATION_MODEL || 'claude-sonnet-4-6-20250930';
	const preTurn = preTurnRoute(ctx.userText, ctx.messages.length);

	if (preTurn.path === 'cloud') {
		logEscalation({
			taskId: ctx.taskId,
			threadId: ctx.threadId,
			localModel: ctx.resolvedModelId,
			localOutputPreview: '',
			escalationReason: preTurn.reason,
			cloudModel: escalationModel,
			source: 'pre_turn'
		});

		const transcript = transcriptFrom(ctx.modelMessages);
		let preTurnErrWriter: SullyErrorWriter | null = null;
		const preTurnStream = createUIMessageStream({
			execute: async ({ writer }) => {
				preTurnErrWriter = writer;
				const messageId = generateId();
				const textId = '0';
				writer.write({ type: 'start', messageId });
				writer.write({
					type: 'data-sully-routing',
					data: { handled_by: 'sdk', model: escalationModel }
				});
				writer.write({ type: 'start-step' });
				writer.write({ type: 'text-start', id: textId });

				let cloudCollected = '';
				let errored = false;
				for await (const chunk of streamViaClaudeCLI({
					model: escalationModel,
					systemPrompt: ctx.systemPrompt,
					userPrompt: transcript || ctx.userText,
					signal: request.signal
				})) {
					if (chunk.type === 'text-delta') {
						cloudCollected += chunk.delta;
						writer.write({ type: 'text-delta', id: textId, delta: chunk.delta });
					} else if (chunk.type === 'error') {
						errored = true;
						emitSullyError(writer, classifySullyError(chunk.message));
						writer.write({ type: 'error', errorText: chunk.message });
					}
				}

				writer.write({ type: 'text-end', id: textId });
				writer.write({ type: 'finish-step' });

				let replyId: number | undefined;
				if (cloudCollected && !errored) {
					updateEscalationCloudOutput(ctx.taskId, cloudCollected);
					replyId = persistAssistantTurn({
						text: cloudCollected,
						sender: 'cc',
						threadId: ctx.threadId,
						model: escalationModel,
						tier: ctx.currentTier,
						taskId: ctx.taskId,
						provider: 'anthropic',
						reused: ctx.reused
					});
				} else if (errored && !cloudCollected) {
					rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
				}

				finishWithReplyId(writer, replyId, errored ? 'error' : 'stop');

				if (cloudCollected && !errored) {
					await applyTurnDecision(decision, {
						taskId: ctx.taskId,
						threadId: ctx.threadId,
						targetRepo: ctx.targetRepo,
						userText: ctx.userText,
						reused: ctx.reused
					});
				}
			},
			onError: (error: unknown) => {
				const text = `Cloud model: ${(error as { message?: string }).message || 'stream_error'}`;
				if (preTurnErrWriter) emitSullyError(preTurnErrWriter, classifySullyError(text));
				return text;
			}
		});
		return createUIMessageStreamResponse({ stream: preTurnStream });
	}

	const SENTINEL_BUFFER_CHARS = 120;
	const escalationSystemPrompt = ctx.systemPrompt + '\n\n' + LOCAL_GATE_INSTRUCTION;
	let localErrWriter: SullyErrorWriter | null = null;
	const localStream = createUIMessageStream({
		execute: async ({ writer }) => {
			localErrWriter = writer;
			const messageId = generateId();
			const textId = '0';
			writer.write({ type: 'start', messageId });
			if (routing) {
				emitRoutingFrame(writer, routing);
			}
			writer.write({ type: 'start-step' });

			let sentinelBuf = '';
			let streaming = false;
			let fullText = '';
			let textStarted = false;
			let errored = false;
			let sawEscalation = false;

			const ensureTextStarted = () => {
				if (!textStarted) {
					writer.write({ type: 'text-start', id: textId });
					textStarted = true;
				}
			};

			const emitTextDelta = (delta: string) => {
				fullText += delta;
				if (streaming) {
					ensureTextStarted();
					writer.write({ type: 'text-delta', id: textId, delta });
					return;
				}
				sentinelBuf += delta;
				if (parseEscalation(sentinelBuf)) {
					sawEscalation = true;
					return;
				}
				if (sentinelBuf.length >= SENTINEL_BUFFER_CHARS) {
					streaming = true;
					ensureTextStarted();
					writer.write({ type: 'text-delta', id: textId, delta: sentinelBuf });
				}
			};

			try {
				const localResult = streamText({
					model,
					system: escalationSystemPrompt,
					messages: await convertToModelMessages(ctx.modelMessages),
					tools,
					stopWhen: ({ steps }) => steps.length >= 8
				});

				// fullStream (not textStream) so Ollama native `delta.reasoning` reaches
				// the client as reasoning-* UI frames. text-start is deferred until the
				// first answer token is actually emitted (after reasoning, if any).
				for await (const part of localResult.fullStream) {
					if (sawEscalation) break;
					switch (part.type) {
						case 'reasoning-start':
							writer.write({ type: 'reasoning-start', id: part.id });
							break;
						case 'reasoning-delta':
							writer.write({ type: 'reasoning-delta', id: part.id, delta: part.text });
							break;
						case 'reasoning-end':
							writer.write({ type: 'reasoning-end', id: part.id });
							break;
						case 'text-delta':
							emitTextDelta(part.text);
							break;
						case 'tool-call':
							(writer.write as (chunk: Record<string, unknown>) => void)({
								type: 'tool-call-start',
								toolCallId: part.toolCallId,
								toolName: part.toolName
							});
							break;
						default:
							break;
					}
				}
			} catch (err) {
				errored = true;
				const errText = `Local model: ${(err as Error).message || 'stream_error'}`;
				emitSullyError(writer, classifySullyError(errText));
				writer.write({ type: 'error', errorText: errText });
				writer.write({ type: 'text-end', id: textId });
				writer.write({ type: 'finish-step' });
				writer.write({ type: 'finish', finishReason: 'error' });
				if (!fullText) rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
				return;
			}

			const localText = streaming ? fullText : sentinelBuf;
			const escalation = parseEscalation(localText);

			if (escalation) {
				logEscalation({
					taskId: ctx.taskId,
					threadId: ctx.threadId,
					localModel: ctx.resolvedModelId,
					localOutputPreview: localText,
					escalationReason: escalation.reason,
					cloudModel: escalationModel
				});

				ensureTextStarted();
				writer.write({ type: 'text-delta', id: textId, delta: '_thinking harder…_\n\n' });
				const transcript = transcriptFrom(ctx.modelMessages);
				let cloudCollected = '';
				for await (const chunk of streamViaClaudeCLI({
					model: escalationModel,
					systemPrompt: ctx.systemPrompt,
					userPrompt: transcript || ctx.userText,
					signal: request.signal
				})) {
					if (chunk.type === 'text-delta') {
						cloudCollected += chunk.delta;
						writer.write({ type: 'text-delta', id: textId, delta: chunk.delta });
					} else if (chunk.type === 'error') {
						errored = true;
						emitSullyError(writer, classifySullyError(chunk.message));
						writer.write({ type: 'error', errorText: chunk.message });
					}
				}

				writer.write({ type: 'text-end', id: textId });
				writer.write({ type: 'finish-step' });

				let replyId: number | undefined;
				if (cloudCollected && !errored) {
					updateEscalationCloudOutput(ctx.taskId, cloudCollected);
					replyId = persistAssistantTurn({
						text: cloudCollected,
						sender: 'cc',
						threadId: ctx.threadId,
						model: escalationModel,
						tier: ctx.currentTier,
						taskId: ctx.taskId,
						provider: 'anthropic',
						reused: ctx.reused
					});
				}

				finishWithReplyId(writer, replyId, errored ? 'error' : 'stop');

				if (cloudCollected && !errored) {
					await applyTurnDecision(decision, {
						taskId: ctx.taskId,
						threadId: ctx.threadId,
						targetRepo: ctx.targetRepo,
						userText: ctx.userText,
						reused: ctx.reused
					});
				}
				return;
			}

			if (!streaming && localText) {
				ensureTextStarted();
				writer.write({ type: 'text-delta', id: textId, delta: localText });
			}
			if (textStarted) {
				writer.write({ type: 'text-end', id: textId });
			}
			writer.write({ type: 'finish-step' });

			let replyId: number | undefined;
			if (localText) {
				replyId = persistAssistantTurn({
					text: localText,
					sender: 'local',
					threadId: ctx.threadId,
					model: ctx.resolvedModelId,
					tier: ctx.currentTier,
					taskId: ctx.taskId,
					provider: ctx.provider,
					reused: ctx.reused
				});
			} else {
				upsertThreadTier(ctx.threadId, ctx.currentTier, ctx.resolvedModelId);
				touchLastActivity(ctx.threadId);
			}

			finishWithReplyId(writer, replyId, 'stop');

			await applyTurnDecision(decision, {
				taskId: ctx.taskId,
				threadId: ctx.threadId,
				targetRepo: ctx.targetRepo,
				userText: ctx.userText,
				reused: ctx.reused
			});
		},
		onError: (error: unknown) => {
			const text = `Local model: ${(error as { message?: string }).message || 'local_stream_error'}`;
			if (localErrWriter) emitSullyError(localErrWriter, classifySullyError(text));
			return text;
		}
	});
	return createUIMessageStreamResponse({ stream: localStream });
}
