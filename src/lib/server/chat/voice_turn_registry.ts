// voice_turn_registry.ts — process-global, in-memory registry of in-flight
// voice-reply turns. The truncate endpoint (`/api/chat/voice-truncate`) looks
// up a turn by `response_id` and triggers a clean abort, so the persisted
// assistant turn matches ONLY the prefix the operator actually heard (Rank 1
// barge-in / truncate protocol from project_voice_mode_backend_backlog).
//
// In-memory is intentional. A turn lives for at most ~30s on the warm path; if
// the node restarts mid-turn the truncate signal would already be moot (the
// stream is dead and the partial transcript wasn't persisted). No cross-node
// recovery is needed — there's only one Sully backend.

export type SentenceLogEntry = {
	i: number;
	text: string;
	fired_ms: number; // when the sentence boundary surfaced (server-rel)
	audio_ms: number | null; // when the WAV bytes were emitted (server-rel)
};

export type TurnRegistryEntry = {
	responseId: string;
	threadId: string;
	taskId: string | null;
	startedAt: number; // ms epoch
	// Called by the truncate endpoint. Should:
	//   - record `audio_end_ms`
	//   - abort the in-flight generation/SSE stream
	//   - cause the turn to persist only the heard prefix
	// Returns true if the truncate signal was accepted, false if the turn
	// already finished or is otherwise not truncatable.
	triggerTruncate: (audio_end_ms: number) => boolean;
};

const turns = new Map<string, TurnRegistryEntry>();

export function registerTurn(entry: TurnRegistryEntry): void {
	turns.set(entry.responseId, entry);
}

export function unregisterTurn(responseId: string): void {
	turns.delete(responseId);
}

export function getTurn(responseId: string): TurnRegistryEntry | undefined {
	return turns.get(responseId);
}

export type TruncateOutcome =
	| { ok: true; response_id: string }
	| { ok: false; reason: 'unknown_response_id' | 'not_truncatable' };

export function truncateTurn(responseId: string, audioEndMs: number): TruncateOutcome {
	const entry = turns.get(responseId);
	if (!entry) return { ok: false, reason: 'unknown_response_id' };
	const accepted = entry.triggerTruncate(audioEndMs);
	if (!accepted) return { ok: false, reason: 'not_truncatable' };
	return { ok: true, response_id: responseId };
}

/** Compute the heard-prefix transcript from a sentence log + the audio_end_ms
 *  the client claims to have actually played. A sentence is "heard" iff its
 *  audio bytes were emitted at or before audio_end_ms. The audio bytes
 *  themselves carry the wall-clock; the client's audio_end_ms is in the same
 *  server-rel time base (it's the highest `ms` field from an `audio` SSE event
 *  whose WAV the client finished playing). */
export function heardPrefixFromLog(
	log: ReadonlyArray<SentenceLogEntry>,
	audioEndMs: number
): string {
	const heard = log
		.filter((s) => s.audio_ms !== null && s.audio_ms <= audioEndMs)
		.map((s) => s.text.trim())
		.filter(Boolean);
	return heard.join(' ').trim();
}

// Test helper. Intentionally not part of the public surface — tests reach in
// via the unmangled module export. Production code MUST NOT call this.
export function _clearAllForTests(): void {
	turns.clear();
}
