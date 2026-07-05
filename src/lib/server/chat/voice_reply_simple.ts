// Non-streaming voice-reply handler (default path, VOICE_REPLY_STREAMING not set).
// Tool-calling loop resolves the full reply, then emits it as plain text tokens.
// Used when the streaming flag is off — same behavior as before the T-stream split.

import { persistAssistantTurn } from '$lib/server/chat_turn';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import { runVoiceToolLoop } from '$lib/server/chat/voice_tools';
import type { VoiceReplyContext, VoiceReplyConstants } from './voice_reply_types';

export function handleVoiceReplySimple(
	ctx: VoiceReplyContext,
	constants: VoiceReplyConstants,
	request: Request
): Response {
	let full = '';
	const enc = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			try {
				let spokeFiller = false;
				const { content } = await runVoiceToolLoop({
					model: constants.model,
					messages: ctx.chatMessages,
					keepAlive: constants.keepAlive,
					numCtx: 4096,
					signal: request.signal,
					taskId: ctx.taskId,
					onToolStart: (toolName) => {
						const filler =
							toolName === 'web_fetch' ? 'Let me pull that up. ' : 'Let me look that up. ';
						controller.enqueue(enc.encode(filler));
						spokeFiller = true;
					}
				});
				void spokeFiller;
				full = content;
				for (const piece of full.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [full]) {
					if (piece.trim()) controller.enqueue(enc.encode(piece));
				}
			} catch (e) {
				console.error('[voice-reply] tool loop failed', e);
			} finally {
				if (full.trim()) {
					persistAssistantTurn({
						text: full.trim(),
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
						if (r?.spokenSuffix) controller.enqueue(enc.encode(' ' + r.spokenSuffix));
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
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
	});
}
