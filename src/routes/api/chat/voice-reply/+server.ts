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
import {
	heardPrefixFromLog,
	registerTurn,
	unregisterTurn,
	type SentenceLogEntry
} from '$lib/server/chat/voice_turn_registry';
import { randomUUID } from 'node:crypto';
import type { TurnDecision } from '$lib/server/routing/turn_decision';

// Voice model id resolved via the shared catalog so a "change the default voice
// model" tweak lands in one place (model_catalog.ts), not three (PR D).
const VOICE_MODEL = resolveVoiceModel();
const HISTORY = 12; // recent turns of context (model SYSTEM carries the persona)

/** Pull dispatch metadata out of a TurnDecision for the dispatch_proposed SSE
 *  event the iOS overlay consumes. Returns null when there's no dispatchable
 *  proposal to surface. */
type DispatchProposalMeta = {
	agent: string;
	target_repo: string;
	brief: string;
	action: string;
	kind: TurnDecision['kind'];
};
function extractDispatchProposal(decision: TurnDecision): DispatchProposalMeta | null {
	const verbForCategory = (category: string): string => {
		const c = category.toLowerCase();
		if (c.includes('research')) return 'run a research pass on that';
		if (c.includes('audit')) return 'audit it';
		if (c.includes('scaffold') || c.includes('plan')) return 'sketch the scaffolding';
		if (c.includes('refactor')) return 'put together a refactor proposal';
		if (c.includes('test') || c.includes('verify')) return 'check that out';
		return 'take a look at that';
	};
	switch (decision.kind) {
		case 'PROPOSE':
		case 'DISPATCH':
			return {
				agent: decision.worker,
				target_repo: '',
				brief: decision.brief,
				action: verbForCategory(decision.category),
				kind: decision.kind
			};
		case 'CONFIRM_PROPOSAL':
			return {
				agent: decision.proposal.worker,
				target_repo: decision.proposal.targetRepo ?? '',
				brief: decision.proposal.brief,
				action: verbForCategory(decision.proposal.category),
				kind: decision.kind
			};
		default:
			return null;
	}
}

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

	// Voice Mode Part A (2026-06-28): bypass the old text/plain short-status
	// path that read robotic ("That looks like a job for CC — ...") AND
	// produced no Kokoro TTS audio. Now we ALWAYS stream the reply through
	// companion-v1-voice so:
	//   - the operator hears a natural-language response, not a template
	//   - the dispatch metadata travels alongside via a `dispatch_proposed`
	//     SSE event the iOS overlay can render
	//   - applyTurnDecision's side effects (DB rows, gate marks, dispatch
	//     calls) still fire — we just decouple them from the spoken output.
	const decision = shadowDecision;
	const dispatchableDecision = !needsFullReply(decision);
	if (dispatchableDecision) {
		// Run applyTurnDecision for its side effects (markGatedProposal,
		// dispatchToWorker, etc.) but suppress BOTH the templated spokenSuffix
		// AND the assistant-side chat row that each branch normally writes —
		// the voice model generates the spoken reply naturally below, and
		// keeping the template row in history was making companion-v1-voice
		// echo the AI-chatbot phrasing on the next turn.
		await applyTurnDecision(decision, {
			taskId,
			threadId,
			targetRepo,
			userText: userMessageText,
			suppressSpokenChatRow: true
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
	// When the turn is dispatchable, splice a short brainstorm-first nudge
	// onto the system prompt so companion-v1-voice doesn't reach for the
	// template ("That looks like a job for X"). The exact phrasing patterns
	// will land in a follow-up after the human-assistant research closes —
	// for now this guides the model to respond naturally and only OPTIONALLY
	// suggest the dispatch at the tail, never lead with it.
	const dispatchProposal = extractDispatchProposal(decision);
	const augmentedSystem =
		dispatchableDecision && dispatchProposal
			? voiceSystem +
				`\n\n## Brainstorming mode (operator's project: "${dispatchProposal.brief}")\n\nRespond like a skilled human assistant in a brainstorming conversation — NOT like an AI offering to do work. Five principles drawn from EA training, hospitality (Ritz-Carlton / Danny Meyer), motivational interviewing, and GROW coaching:\n\n1. Engage with what the operator actually said FIRST. React to the substance. Ask a clarifying question if it'd genuinely help. Don't pivot to "want me to do X?" — that closes the brainstorm.\n2. Stay in OPTIONS, not WILL. The operator is still shaping the idea. Don't jump to "I'll set that up" mid-thought.\n3. Anticipation beats offering. Note that ${dispatchProposal.agent} could help with this kind of work — don't ASK if they want it. The acknowledgment is enough.\n4. If you do surface the dispatch possibility, put it at the TAIL of the reply, conditional, brief. Never lead with it.\n5. Hand the floor back.\n\nGood tail-phrases (use sparingly, only when fitting):\n- "I've got ${dispatchProposal.agent} cued if you go that direction."\n- "If it'd help, ${dispatchProposal.agent} could ${dispatchProposal.action} while you keep thinking."\n- "That one ${dispatchProposal.agent} can just take — say the word."\n- "Whenever you're ready, ${dispatchProposal.agent} is one nod from me."\n\nNEVER use any of these (they read as a robot or a servile chatbot):\n- "This looks like a job for ${dispatchProposal.agent}"\n- "Want me to dispatch this?"\n- "Should I have ${dispatchProposal.agent} get on that right now?"\n- "Let me know what you want me to do next."\n- "I can definitely help with that!"\n\nSometimes the best move is just listening — "Hm, keep going" is a complete reply. Don't force a dispatch suggestion every turn.`
			: voiceSystem;
	const chatMessages = [{ role: 'system', content: augmentedSystem }, ...turns];

	// ── T-stream (VOICE_REPLY_STREAMING) ────────────────────────────────────
	// Stream tokens from Ollama and fire each sentence to Kokoro the moment it
	// lands, so the first sentence is audible WHILE the model is still
	// generating (SSE: sentence/audio/done + ms timing). Tool turns fall back to
	// the proven non-streaming loop inside runVoiceStreamingSpeak. Flag OFF → the
	// await-then-emit text path below (rollback, byte-for-byte unchanged).
	if (process.env.VOICE_REPLY_STREAMING === 'true') {
		const sseEnc = new TextEncoder();
		// Mint a response_id and an internal AbortController so the truncate
		// endpoint (`/api/chat/voice-truncate`) can cleanly interrupt this turn
		// mid-stream and persist only what the operator actually heard. Also chain
		// the inbound request.signal so a client disconnect still cancels Ollama.
		const responseId = randomUUID();
		const genAbort = new AbortController();
		const onClientAbort = () => genAbort.abort('client_disconnect');
		if (request.signal.aborted) genAbort.abort('client_disconnect_pre');
		else request.signal.addEventListener('abort', onClientAbort, { once: true });
		let truncatedAt: number | null = null;
		registerTurn({
			responseId,
			threadId,
			taskId: taskId ?? null,
			startedAt: turnStartedAt,
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
				try {
					// Dispatch metadata event for the iOS overlay (Voice Mode
					// Part A). Emitted BEFORE the first text-delta so the
					// overlay can render alongside the spoken reply. Verbal
					// confirmation phrase is the operator's verbatim "yes"
					// pattern — tap on the overlay button is symmetric.
					if (dispatchProposal) {
						controller.enqueue(
							sseEnc.encode(
								`event: dispatch_proposed\ndata: ${JSON.stringify({
									agent: dispatchProposal.agent,
									target_repo: dispatchProposal.target_repo || targetRepo,
									brief: dispatchProposal.brief,
									verbal_phrase: 'Yes, run that',
									trace_id: taskId ?? null,
									kind: dispatchProposal.kind
								})}\n\n`
							)
						);
					}
					const res = await runVoiceStreamingSpeak(
						{
							model: VOICE_MODEL,
							messages: chatMessages,
							keepAlive: VOICE_KEEP_ALIVE,
							numCtx: 4096,
							signal: genAbort.signal,
							taskId,
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
					unregisterTurn(responseId);
					request.signal.removeEventListener('abort', onClientAbort);

					// Persistence decision tree:
					//  - aborted + truncatedAt set → operator barge-in. Persist ONLY
					//    the heard prefix, mark status='truncated', emit a typed
					//    'truncated' SSE event so the client knows what landed.
					//  - aborted + no truncate     → upstream client disconnect mid-
					//    reply. Don't persist (no operator audience for the rest).
					//  - not aborted               → normal turn. Persist full text.
					if (aborted && truncatedAt !== null) {
						const heard = heardPrefixFromLog(sentenceLog, truncatedAt);
						persistAssistantTurn({
							text: heard || '(interrupted before first sentence)',
							sender: 'local',
							threadId,
							model: VOICE_MODEL,
							tier: currentTier,
							taskId,
							provider: 'local',
							latencyMs: Date.now() - turnStartedAt,
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
							threadId,
							model: VOICE_MODEL,
							tier: currentTier,
							taskId,
							provider: 'local',
							latencyMs: Date.now() - turnStartedAt
						});
						try {
							// suppressSpokenChatRow: companion-v1-voice / cloud model
							// already streamed the natural reply above. We only
							// want gate marks + dispatch bookkeeping here, NOT
							// another templated row in chat_messages.
							const r = await applyTurnDecision(decision, {
								taskId,
								threadId,
								targetRepo,
								userText: userMessageText,
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
							userText: userMessageText,
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
};
