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
import { finishWithReplyId, rollbackOrphanTurn } from '$lib/server/chat/sdk_stream_common';

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
}): Response {
	const { ctx, request, model, tools } = opts;
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
		const preTurnStream = createUIMessageStream({
			execute: async ({ writer }) => {
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
			onError: (error: unknown) =>
				`Cloud model: ${(error as { message?: string }).message || 'stream_error'}`
		});
		return createUIMessageStreamResponse({ stream: preTurnStream });
	}

	const SENTINEL_BUFFER_CHARS = 120;
	const escalationSystemPrompt = ctx.systemPrompt + '\n\n' + LOCAL_GATE_INSTRUCTION;
	const localStream = createUIMessageStream({
		execute: async ({ writer }) => {
			const messageId = generateId();
			const textId = '0';
			writer.write({ type: 'start', messageId });
			writer.write({ type: 'start-step' });
			writer.write({ type: 'text-start', id: textId });

			let sentinelBuf = '';
			let streaming = false;
			let fullText = '';
			let errored = false;

			try {
				const localResult = streamText({
					model,
					system: escalationSystemPrompt,
					messages: await convertToModelMessages(ctx.modelMessages),
					tools,
					stopWhen: ({ steps }) => steps.length >= 8
				});

				for await (const chunk of localResult.textStream) {
					fullText += chunk;
					if (streaming) {
						writer.write({ type: 'text-delta', id: textId, delta: chunk });
					} else {
						sentinelBuf += chunk;
						if (parseEscalation(sentinelBuf)) break;
						if (sentinelBuf.length >= SENTINEL_BUFFER_CHARS) {
							streaming = true;
							writer.write({ type: 'text-delta', id: textId, delta: sentinelBuf });
						}
					}
				}
			} catch (err) {
				errored = true;
				writer.write({
					type: 'error',
					errorText: `Local model: ${(err as Error).message || 'stream_error'}`
				});
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
				writer.write({ type: 'text-delta', id: textId, delta: localText });
			}
			writer.write({ type: 'text-end', id: textId });
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
		onError: (error: unknown) =>
			`Local model: ${(error as { message?: string }).message || 'local_stream_error'}`
	});
	return createUIMessageStreamResponse({ stream: localStream });
}
