// POST /api/chat/voice-truncate — Rank 1 barge-in / truncate protocol.
//
// The client (iOS later, harness today) calls this when the operator started
// speaking before Sully finished. Carries the `response_id` (from the matching
// voice-reply meta SSE event) plus `audio_end_ms` — the highest `ms` field
// from an `audio` SSE event whose WAV the client finished playing. Server:
//   1. Aborts the in-flight Ollama generation.
//   2. Stops queueing further TTS sentences.
//   3. Computes the heard prefix from the per-sentence audio log.
//   4. Persists only that prefix as the assistant turn (status='truncated').
//   5. Emits a typed `truncated` SSE event on the original voice-reply stream.
//
// On unknown response_id (the turn already finished, or the id is wrong) the
// endpoint returns 404 — the client should treat that as a no-op.
//
// Lives in the SvelteKit backend, NOT the Jetson STT bridge. The truncate
// authority is conversation-state authority, which belongs next to companion.db.

import type { RequestHandler } from './$types';
import { truncateTurn } from '$lib/server/chat/voice_turn_registry';

export const POST: RequestHandler = async ({ request }) => {
	let responseId: string;
	let audioEndMs: number;
	try {
		const body = (await request.json()) as { response_id?: unknown; audio_end_ms?: unknown };
		if (typeof body.response_id !== 'string' || !body.response_id.trim()) {
			return new Response(JSON.stringify({ ok: false, reason: 'missing_response_id' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		if (typeof body.audio_end_ms !== 'number' || !Number.isFinite(body.audio_end_ms)) {
			return new Response(JSON.stringify({ ok: false, reason: 'missing_audio_end_ms' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		responseId = body.response_id;
		audioEndMs = body.audio_end_ms;
	} catch {
		return new Response(JSON.stringify({ ok: false, reason: 'invalid_json' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const outcome = truncateTurn(responseId, audioEndMs);
	if (!outcome.ok) {
		// unknown_response_id: turn already finished or never existed. This is the
		// common race when the client's barge-in and Sully's natural finish land
		// in the same tick — treat as a benign no-op (404, not 500).
		return new Response(JSON.stringify({ ok: false, reason: outcome.reason }), {
			status: outcome.reason === 'unknown_response_id' ? 404 : 409,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	return new Response(
		JSON.stringify({ ok: true, response_id: outcome.response_id, audio_end_ms: audioEndMs }),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
};
