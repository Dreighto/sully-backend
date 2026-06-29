// POST /api/chat/voice-specialist — Rank 2 out-of-band Specialist escalation
// for voice turns.
//
// Deterministic, BACKEND-OWNED route — the voice model (companion-v1-voice on
// Ollama) is NOT responsible for deciding whether to escalate. Per operator
// guidance (Gateway review 2026-06-27): "do not make the voice model
// responsible for deciding Specialist flow. Add a backend-owned route or shim
// that calls the existing text Specialist lane out-of-band, then returns a
// short spoken summary."
//
// Maps 1:1 onto the text-chat Specialist path:
//   - Same Claude CLI (OAuth) bridge as `sdk-stream/+server.ts:useClaudeCLI`
//   - Same `data-sully-routing` meta frame so the iOS UI can flip chrome
//   - Same `escalation_corpus.jsonl` log target (with `source:'voice'` tag)
//
// Out-of-band = the reply is NOT written to `chat_messages`. The voice
// session quarantines the Specialist generation so it never lands in the
// thread's turn history (OpenAI Realtime calls this `response.conversation:
// 'none'`). The caller (iOS) decides whether to TTS-play it and whether to
// inject a summary as the next voice-reply's preamble.
//
// Wire format (text/event-stream):
//   event: meta             data: { voice_session_id, escalation_id, model, tier, handled_by: 'sdk' }
//   event: data-sully-routing  data: { handled_by: 'sdk', model, source: 'voice' }
//   event: text-delta       data: { delta }
//   ... (repeated) ...
//   event: done             data: { full_text, latency_ms, model, escalation_id }
//   event: error            data: { message }   (on failure path; precedes done)

import type { RequestHandler } from './$types';
import { randomUUID } from 'node:crypto';
import { streamViaClaudeCLI } from '$lib/server/claude_cli_stream';
import { logEscalation } from '$lib/server/escalation_telemetry';

// Tier → concrete model id. Hard-wired to the two Specialist-tier models from
// the Companion's existing matrix. New tiers go here.
const TIER_MODEL: Record<'sonnet' | 'opus', string> = {
	sonnet: 'claude-sonnet-4-6',
	opus: 'claude-opus-4-8'
};

// System prompt for voice-mode Specialist replies. Tuned for TTS:
//   - plain prose, no markdown / lists / code fences
//   - concise (2-4 sentences typically) — voice doesn't want the full text
//     Specialist's long-form output
//   - acknowledges its out-of-band nature so it doesn't say things like "as
//     we discussed earlier" that would reference a thread it can't see
const VOICE_SPECIALIST_SYSTEM = `You are Sully's Specialist — answering a single out-of-band voice question, NOT continuing a thread.

Rules:
- Reply in plain prose suitable for text-to-speech. No markdown, no bullet points, no headers, no code fences.
- Keep it concise: 2 to 4 sentences, ~50-100 words. Voice replies that overrun feel like monologues.
- Do not reference prior turns; you don't have the thread. If the prompt is ambiguous, answer the most plausible reading and say so briefly.
- Don't preface with "Sure" or "As you asked"; just answer.`;

function sseLine(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const POST: RequestHandler = async ({ request }) => {
	let prompt = '';
	let tier: 'sonnet' | 'opus' = 'sonnet';
	let voiceSessionId: string | undefined;
	let threadId = 'voice-default';
	let metadata: Record<string, unknown> | undefined;
	try {
		const body = (await request.json()) as {
			prompt?: unknown;
			tier?: unknown;
			voice_session_id?: unknown;
			thread?: unknown;
			metadata?: unknown;
		};
		if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
			return new Response(JSON.stringify({ ok: false, reason: 'missing_prompt' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		prompt = body.prompt.trim();
		if (body.tier === 'opus' || body.tier === 'sonnet') tier = body.tier;
		if (typeof body.voice_session_id === 'string' && body.voice_session_id.trim()) {
			voiceSessionId = body.voice_session_id.trim();
		}
		if (typeof body.thread === 'string' && body.thread.trim()) {
			threadId = body.thread.trim();
		}
		if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
			metadata = body.metadata as Record<string, unknown>;
		}
	} catch {
		return new Response(JSON.stringify({ ok: false, reason: 'invalid_json' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const model = TIER_MODEL[tier];
	const escalationId = randomUUID();
	const startedAt = Date.now();
	const enc = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			let collected = '';
			let errored: string | null = null;
			try {
				controller.enqueue(
					enc.encode(
						sseLine('meta', {
							voice_session_id: voiceSessionId ?? null,
							escalation_id: escalationId,
							model,
							tier,
							handled_by: 'sdk',
							turn_started_ms: startedAt
						})
					)
				);
				// `data-sully-routing` — same custom channel name the text-chat
				// Specialist path uses (sdk-stream/+server.ts:262). The iOS client's
				// UIPart enum already maps this to the Warm Sand accent flip; the
				// `source: 'voice'` discriminator lets it flare the orb vs the model
				// pill depending on which surface emitted the route signal.
				controller.enqueue(
					enc.encode(
						sseLine('data-sully-routing', {
							handled_by: 'sdk',
							model,
							source: 'voice'
						})
					)
				);

				for await (const chunk of streamViaClaudeCLI({
					model,
					systemPrompt: VOICE_SPECIALIST_SYSTEM,
					userPrompt: prompt,
					signal: request.signal
				})) {
					if (chunk.type === 'text-delta') {
						collected += chunk.delta;
						controller.enqueue(enc.encode(sseLine('text-delta', { delta: chunk.delta })));
					} else if (chunk.type === 'error') {
						errored = chunk.message;
						controller.enqueue(enc.encode(sseLine('error', { message: chunk.message })));
					}
					// 'finish' is the generator returning; loop ends naturally.
				}

				const latencyMs = Date.now() - startedAt;
				controller.enqueue(
					enc.encode(
						sseLine('done', {
							full_text: collected.trim(),
							latency_ms: latencyMs,
							model,
							escalation_id: escalationId
						})
					)
				);
			} catch (e) {
				const msg = (e as Error).message || String(e);
				errored = msg;
				try {
					controller.enqueue(enc.encode(sseLine('error', { message: msg })));
				} catch {
					/* already closed */
				}
			} finally {
				// Append-only telemetry — same target as the text Specialist lane,
				// `source:'voice'` discriminator + voice_session_id correlation. Best
				// effort; logEscalation swallows its own errors.
				logEscalation({
					at: new Date().toISOString(),
					thread_id: threadId,
					task_id: null,
					user_prompt: prompt,
					system_prompt_head: VOICE_SPECIALIST_SYSTEM.slice(0, 800),
					provider: 'anthropic',
					model,
					current_tier: tier,
					target_repo: 'voice-out-of-band',
					source: 'voice',
					voice_session_id: voiceSessionId,
					metadata,
					reply_text: collected.trim() || undefined,
					latency_ms: Date.now() - startedAt,
					error: errored ?? undefined
				});
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
};
