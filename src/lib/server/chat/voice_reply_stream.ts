// Streaming voice-reply handler (VOICE_REPLY_STREAMING=true).
// SSE stream: sentences are fired to Kokoro TTS as they land; the client
// receives sentence/audio SSE events. Truncation (barge-in) persists only the
// heard prefix.

import { randomUUID } from 'node:crypto';
import { persistAssistantTurn } from '$lib/server/chat_turn';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import { runVoiceStreamingSpeak } from '$lib/server/chat/voice_stream';
import {
	heardPrefixFromLog,
	registerTurn,
	unregisterTurn,
	type SentenceLogEntry
} from '$lib/server/chat/voice_turn_registry';
import type { VoiceReplyContext, VoiceReplyConstants } from './voice_reply_types';

export function handleVoiceReplyStream(
	ctx: VoiceReplyContext,
	constants: VoiceReplyConstants,
	request: Request
): Response {
	const sseEnc = new TextEncoder();
	const responseId = randomUUID();
	const genAbort = new AbortController();
	const onClientAbort = () => genAbort.abort('client_disconnect');
	if (request.signal.aborted) genAbort.abort('client_disconnect_pre');
	else request.signal.addEventListener('abort', onClientAbort, { once: true });
	let truncatedAt: number | null = null;
	registerTurn({
		responseId,
		threadId: ctx.threadId,
		taskId: ctx.taskId ?? null,
		startedAt: ctx.turnStartedAt,
		triggerTruncate: (audio_end_ms: number) => {
			if (truncatedAt !== null) return false;
			truncatedAt = Math.max(0, Math.floor(audio_end_ms));
			genAbort.abort('truncate');
			return true;
		}
	});

	const stream = new ReadableStream({
		async start(controller) {
			let transcript = '';
			let aborted = false;
			let sentenceLog: SentenceLogEntry[] = [];
			// SSE comment heartbeat: keep the connection warm and let the client
			// distinguish "still generating" from "dead" during the LLM gap before
			// first audio (deep audit 2026-07-07). `:`-prefixed lines are SSE
			// comments the client ignores; they only reset its inter-packet timer.
			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(sseEnc.encode(`: ping\n\n`));
				} catch {
					/* stream already closed */
				}
			}, 1000);
			try {
				if (ctx.dispatchProposal) {
					controller.enqueue(
						sseEnc.encode(
							`event: dispatch_proposed\ndata: ${JSON.stringify({
								agent: ctx.dispatchProposal.agent,
								target_repo: ctx.dispatchProposal.target_repo || ctx.targetRepo || '',
								brief: ctx.dispatchProposal.brief,
								verbal_phrase: 'Yes, run that',
								trace_id: ctx.taskId ?? null,
								kind: ctx.dispatchProposal.kind
							})}\n\n`
						)
					);
				}
				const res = await runVoiceStreamingSpeak(
					{
						model: constants.model,
						messages: ctx.chatMessages,
						keepAlive: constants.keepAlive,
						numCtx: 4096,
						signal: genAbort.signal,
						taskId: ctx.taskId,
						responseId
					},
					controller,
					sseEnc
				);
				transcript = res.transcript;
				aborted = res.aborted;
				sentenceLog = res.sentenceLog;
			} catch (e) {
				console.error('[voice-reply] streaming path failed', e);
				try {
					controller.enqueue(
						sseEnc.encode(
							`event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`
						)
					);
				} catch {
					/* already closed */
				}
			} finally {
				clearInterval(heartbeat);
				unregisterTurn(responseId);
				request.signal.removeEventListener('abort', onClientAbort);

				if (aborted && truncatedAt !== null) {
					const heard = heardPrefixFromLog(sentenceLog, truncatedAt);
					persistAssistantTurn({
						text: heard || '(interrupted before first sentence)',
						sender: 'local',
						threadId: ctx.threadId,
						model: constants.model,
						tier: ctx.currentTier,
						taskId: ctx.taskId,
						provider: 'local',
						latencyMs: Date.now() - ctx.turnStartedAt,
						status: 'truncated'
					});
					try {
						controller.enqueue(
							sseEnc.encode(
								`event: truncated\ndata: ${JSON.stringify({
									response_id: responseId,
									audio_end_ms: truncatedAt,
									heard_transcript: heard,
									generated_transcript: transcript.trim(),
									sentence_count: sentenceLog.length
								})}\n\n`
							)
						);
					} catch {
						/* already closed */
					}
				} else if (!aborted && transcript.trim()) {
					persistAssistantTurn({
						text: transcript.trim(),
						sender: 'local',
						threadId: ctx.threadId,
						model: constants.model,
						tier: ctx.currentTier,
						taskId: ctx.taskId,
						provider: 'local',
						latencyMs: Date.now() - ctx.turnStartedAt
					});
					try {
						const r = await applyTurnDecision(ctx.decision, {
							taskId: ctx.taskId,
							threadId: ctx.threadId,
							targetRepo: ctx.targetRepo,
							userText: ctx.userMessageText,
							suppressSpokenChatRow: true
						});
						if (r?.spokenSuffix) {
							controller.enqueue(
								sseEnc.encode(
									`event: suffix\ndata: ${JSON.stringify({ text: r.spokenSuffix })}\n\n`
								)
							);
						}
					} catch (e) {
						console.error('[voice-reply] autonomous-dispatch failed', e);
					}
				}
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			}
		}
	});
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-store',
			Connection: 'keep-alive'
		}
	});
}
