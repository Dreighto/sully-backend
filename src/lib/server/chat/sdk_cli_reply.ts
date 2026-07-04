import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	generateId,
	type UIMessage
} from 'ai';
import type { PreparedStreamContext } from '$lib/server/chat/stream_prepare';
import { streamViaClaudeCLI } from '$lib/server/claude_cli_stream';
import { persistAssistantTurn } from '$lib/server/chat_turn';
import { upsertThreadTier } from '$lib/server/thread_state';
import { touchLastActivity } from '$lib/server/thread_meta';
import {
	extractAndPromoteArtifacts,
	hasLiveArtifactSignal
} from '$lib/server/chat/artifact_sentinel';
import { mintTeacherTraceId } from '$lib/server/artifactStore';
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

export function handleCliReply(ctx: PreparedStreamContext, request: Request): Response {
	const senderLabel = 'cc' as const;
	const cliSystemPrompt = ctx.systemPrompt;
	const artifactTrace = mintTeacherTraceId();
	const decision = ctx.shadowDecision;
	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			const messageId = generateId();
			const textId = '0';
			writer.write({ type: 'start', messageId });
			writer.write({ type: 'start-step' });
			writer.write({ type: 'text-start', id: textId });

			const transcript = transcriptFrom(ctx.modelMessages);
			let collected = '';
			let errored = false;
			let artifactSignaled = false;
			for await (const chunk of streamViaClaudeCLI({
				model: ctx.resolvedModelId,
				systemPrompt: cliSystemPrompt,
				userPrompt: transcript || 'hello',
				signal: request.signal
			})) {
				if (chunk.type === 'text-delta') {
					collected += chunk.delta;
					writer.write({ type: 'text-delta', id: textId, delta: chunk.delta });
					if (!artifactSignaled && hasLiveArtifactSignal(collected)) {
						artifactSignaled = true;
						writer.write({ type: 'data-sully-artifact', data: { traceId: artifactTrace } });
					}
				} else if (chunk.type === 'error') {
					errored = true;
					writer.write({ type: 'error', errorText: chunk.message });
				}
			}

			writer.write({ type: 'text-end', id: textId });
			writer.write({ type: 'finish-step' });

			let replyId: number | undefined;
			if (collected && !errored) {
				const { strippedText, artifacts } = extractAndPromoteArtifacts(
					collected,
					{ threadId: ctx.threadId, taskId: ctx.taskId },
					artifactTrace
				);
				replyId = persistAssistantTurn({
					text: strippedText || collected,
					sender: senderLabel,
					threadId: ctx.threadId,
					model: ctx.resolvedModelId,
					tier: ctx.currentTier,
					taskId: ctx.taskId,
					traceId: artifacts[0]?.trace_id ?? null,
					provider: ctx.provider,
					reused: ctx.reused
				});
			} else if (!errored) {
				upsertThreadTier(ctx.threadId, ctx.currentTier, ctx.resolvedModelId);
				touchLastActivity(ctx.threadId);
			} else if (!collected) {
				rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
			}

			finishWithReplyId(writer, replyId, errored ? 'error' : 'stop');

			if (!errored) {
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
			const m = (error as { message?: string })?.message || 'cli_stream_error';
			return `Claude CLI bridge: ${m}`;
		}
	});
	return createUIMessageStreamResponse({ stream });
}
