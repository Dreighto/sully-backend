// Voice-turn reply stream. Takes the operator's (spoken→STT) text, persists it,
// and streams companion-v1-voice's reply back as PLAIN TEXT tokens (simple to
// render live + segment into sentences for per-sentence TTS — much easier to
// consume than the AI-SDK data-stream protocol). Persists the assistant reply
// when the stream completes. The companion persona lives in the model's own
// SYSTEM (Modelfile), so we just pass the recent conversation turns.
//
// Uses companion-v1-voice (8192 ctx) — the GPU-resident, full-speed voice model.
// request.signal is propagated to Ollama so a barge-in (client abort) stops
// generation server-side too.

import type { RequestHandler } from './$types';
import { getChatMessages } from '$lib/server/chat';
import { resolveVoiceModel } from '$lib/server/model_catalog';
import { VOICE_KEEP_ALIVE } from '$lib/server/voice_runtime';
import { buildVoiceSystemPrompt } from '$lib/server/chat_prompt';
import { persistAssistantTurn } from '$lib/server/chat_turn';
import { prepareTurnLifecycle } from '$lib/server/chat/stream_prepare';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import { needsFullReply } from '$lib/server/routing/turn_decision';
import { runVoiceToolLoop } from '$lib/server/chat/voice_tools';
import { runVoiceStreamingSpeak } from '$lib/server/chat/voice_stream';

// Voice model id resolved via the shared catalog so a "change the default voice
// model" tweak lands in one place (model_catalog.ts), not three (PR D).
const VOICE_MODEL = resolveVoiceModel();
const HISTORY = 12; // recent turns of context (model SYSTEM carries the persona)

export const POST: RequestHandler = async ({ request }) => {
	let text = '';
	let threadId = 'default';
	try {
		const body = await request.json();
		text = (body.text || '').trim();
		threadId = body.thread || 'default';
	} catch {
		return new Response('invalid json', { status: 400 });
	}
	if (!text) return new Response('empty text', { status: 400 });

	// ── Same Task lifecycle as text (operator's first-class-voice rule). ──────
	// Voice is just spoken input: it mints a Task, classifies the turn, persists
	// the operator turn, and (below) persists the reply + runs autonomous
	// dispatch through the SAME primitives the text path uses. The ONLY
	// difference is the streaming output format — plain text tokens for
	// low-latency per-sentence TTS instead of the SDK data-stream protocol.
	// prepareTurnLifecycle is the single shared chokepoint for the full turn
	// lifecycle — mint Task id, persistUserTurn (mints 'proposed' row + journals
	// task_proposed + writes operator chat row), classifyAndTouchThread, and
	// detectTargetRepo. The Mutation Gate (R2) will hook in here.
	const { taskId, currentTier, targetRepo, shadowDecision, userMessageText } =
		await prepareTurnLifecycle({
			text,
			threadId,
			source: 'voice'
		});

	// D2.2: Classify-before-answer gate. A work turn speaks ONLY the short status
	// returned by applyTurnDecision — never a full spoken answer first.
	const decision = shadowDecision;
	if (!needsFullReply(decision)) {
		const { spokenSuffix } = await applyTurnDecision(decision, {
			taskId,
			threadId,
			targetRepo,
			userText: userMessageText
		});
		const enc = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				if (spokenSuffix) controller.enqueue(enc.encode(spokenSuffix));
				controller.close();
			}
		});
		return new Response(stream, {
			headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
		});
	}

	// Latency stamp for the reply's forensics.
	const turnStartedAt = Date.now();

	// Build the message list from recent thread history (drop system markers).
	const recent = getChatMessages(HISTORY, threadId) as Array<{ sender: string; message: string }>;
	const messages = recent
		.filter((m) => m.sender !== 'system')
		.map((m) => ({ role: m.sender === 'operator' ? 'user' : 'assistant', content: m.message }));
	// The history window can slide so it begins with an assistant turn — Ollama/the
	// model then returns an empty reply. Drop leading assistant turns so the array
	// always starts with a user message (the model's persona lives in its SYSTEM).
	while (messages.length && messages[0].role !== 'user') messages.shift();
	// Defensive: collapse consecutive same-role turns into one so the model always
	// sees clean user/assistant alternation. A run of consecutive user turns (e.g.
	// rapid sends, or malformed history) otherwise makes qwen's chat template emit
	// an empty reply.
	const turns: Array<{ role: string; content: string }> = [];
	for (const m of messages) {
		const last = turns[turns.length - 1];
		if (last && last.role === m.role) last.content += '\n' + m.content;
		else turns.push({ ...m });
	}

	// Prepend the voice system prompt (persona + live local time + memory layers).
	// Overrides companion-v1-voice's stale baked-in Modelfile SYSTEM so voice
	// matches the text Sully — warm, short, no spoken lists, time-aware.
	const voiceSystem = await buildVoiceSystemPrompt(threadId, userMessageText);
	const chatMessages = [{ role: 'system', content: voiceSystem }, ...turns];

	// ── T-stream (VOICE_REPLY_STREAMING) ────────────────────────────────────
	// Stream tokens from Ollama and fire each sentence to Kokoro the moment it
	// lands, so the first sentence is audible WHILE the model is still
	// generating (SSE: sentence/audio/done + ms timing). Tool turns fall back to
	// the proven non-streaming loop inside runVoiceStreamingSpeak. Flag OFF → the
	// await-then-emit text path below (rollback, byte-for-byte unchanged).
	if (process.env.VOICE_REPLY_STREAMING === 'true') {
		const sseEnc = new TextEncoder();
		const stream = new ReadableStream({
			async start(controller) {
				let transcript = '';
				try {
					const res = await runVoiceStreamingSpeak(
						{
							model: VOICE_MODEL,
							messages: chatMessages,
							keepAlive: VOICE_KEEP_ALIVE,
							numCtx: 4096,
							signal: request.signal,
							taskId
						},
						controller,
						sseEnc
					);
					transcript = res.transcript;
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
					if (transcript.trim()) {
						persistAssistantTurn({
							text: transcript.trim(),
							sender: 'local',
							threadId,
							model: VOICE_MODEL,
							tier: currentTier,
							taskId,
							provider: 'local',
							latencyMs: Date.now() - turnStartedAt
						});
						try {
							const r = await applyTurnDecision(decision, {
								taskId,
								threadId,
								targetRepo,
								userText: userMessageText
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

	let full = '';
	const enc = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			try {
				// Tool-calling loop: the voice model can web_search / web_fetch via
				// the operator's Ollama Pro key, same tools text Sully has. Resolves
				// non-streaming (we must inspect tool_calls cleanly), then we emit
				// the final spoken answer below. For a normal no-tool turn this is a
				// single inference and returns immediately. Tools auto-disable if
				// OLLAMA_API_KEY is absent.
				// Spoken filler when a tool (web search/fetch) is about to run, so
				// the multi-second round-trip doesn't feel like a hang. Emitted to
				// the TTS stream immediately; NOT persisted as part of the reply.
				let spokeFiller = false;
				const { content } = await runVoiceToolLoop({
					model: VOICE_MODEL,
					messages: chatMessages,
					keepAlive: VOICE_KEEP_ALIVE,
					numCtx: 4096,
					signal: request.signal,
					taskId,
					onToolStart: (toolName) => {
						const filler =
							toolName === 'web_fetch' ? 'Let me pull that up. ' : 'Let me look that up. ';
						controller.enqueue(enc.encode(filler));
						spokeFiller = true;
					}
				});
				void spokeFiller; // (the flag documents intent; filler already streamed)
				full = content;
				// Emit the final answer sentence-by-sentence so the client transcript
				// + per-sentence TTS still get incremental input.
				for (const piece of full.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [full]) {
					if (piece.trim()) controller.enqueue(enc.encode(piece));
				}
			} catch (e) {
				// barge-in (client abort) or model error — fall through to persist
				// whatever we have (usually nothing).
				console.error('[voice-reply] tool loop failed', e);
			} finally {
				if (full.trim()) {
					// Persist the spoken reply through the shared turn service so it
					// carries task_id + forensics (model/provider/latency) exactly
					// like a text reply. sender='local' (the voice model).
					persistAssistantTurn({
						text: full.trim(),
						sender: 'local',
						threadId,
						model: VOICE_MODEL,
						tier: currentTier,
						taskId,
						provider: 'local',
						latencyMs: Date.now() - turnStartedAt
					});
					// D2.2: Replace maybeAutonomousDispatch with applyTurnDecision.
					// decision is ANSWER_NOW/CONVERSATIONAL_ONLY here (work turns already
					// short-circuited above). For a Talk decision applyTurnDecision returns
					// {} (no spokenSuffix) — fine. AWAITED so any spokenSuffix (edge cases)
					// is spoken before the stream closes.
					try {
						const r = await applyTurnDecision(decision, {
							taskId,
							threadId,
							targetRepo,
							userText: userMessageText
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
};
