// Client-side transcript gating for the two voice paths (LOS-203, defense in
// depth behind the bridge-side fixes). Pure and browser-API-free — same
// doctrine as `stt-bridge.ts` — so the gating decisions are unit-testable in
// the node test env while the browser-coupled controllers stay thin.
//
// Two independent gates, applied to every STT `final` before it can dispatch:
//
//   1. CONTENT — trim; drop empty/whitespace; drop text with no visible
//      characters (zero-width spaces, BOMs, control chars — anything that
//      would render as an empty bubble but still hit /api/chat).
//   2. STALENESS — a monotonically increasing voice-session/turn id. The
//      controller captures an id at socket open AND at each capture-turn
//      start, tags its pending resolver/handler with it, and invalidates all
//      outstanding ids on stop/close/restart. A `final` whose tagged id
//      predates the last boundary is stale (e.g. a WS reconnect delivering a
//      queued final from the OLD connection into the NEW session) and is
//      dropped before it can touch any state.
//
// Every accepted/dropped final emits one dev-gated console line (text LENGTH
// only — never transcript content) so the decision trail is visible in the
// client console without leaking what the operator said.

/** Which voice pipeline produced the final (for the debug log). */
export type VoicePath = 'talkback' | 'realtime';

/** The gate's verdict on one STT `final`. */
export type GateDecision = 'accepted' | 'dropped-empty' | 'dropped-stale';

export interface GateResult {
	decision: GateDecision;
	/** The trimmed transcript when accepted; '' on any drop. */
	text: string;
}

/**
 * The id a handler/resolver carries when no live capture armed it (e.g. an
 * unsolicited `final` with no pending turn). Never live — ids start at 1.
 */
export const STALE_ID = 0;

/**
 * True when the string contains at least one visible character. `\s` covers
 * Unicode whitespace; `\p{Cf}` (format: zero-width space/joiner, BOM, soft
 * hyphen, directional marks) and `\p{Cc}` (controls) cover the invisible
 * characters that survive a trim but render as nothing.
 */
export function hasVisibleCharacters(s: string): boolean {
	return /[^\s\p{Cf}\p{Cc}]/u.test(s);
}

export interface TranscriptGate {
	/**
	 * Issue a new id — call at socket open and at each capture-turn start, and
	 * tag the pending resolver/handler with the returned id.
	 */
	begin: () => number;
	/**
	 * Boundary: invalidate every outstanding id. Call on voice-mode stop,
	 * socket close/teardown, and session restart, so nothing armed before the
	 * boundary can resolve after it.
	 */
	invalidate: () => void;
	/** Is this tagged id still live (issued, and no boundary since)? */
	isLive: (id: number) => boolean;
	/**
	 * Gate one STT `final`: staleness first, then content. Logs exactly one
	 * dev-gated decision line per call. `taggedId` is the id the resolving
	 * handler/resolver was armed with (STALE_ID when nothing was armed).
	 */
	gateFinal: (rawText: unknown, taggedId: number) => GateResult;
}

/**
 * One gate per controller instance. `dev` gates the per-final console line
 * (pass `$app/environment`'s `dev` from controllers; explicit in tests).
 */
export function createTranscriptGate(path: VoicePath, dev = false): TranscriptGate {
	let seq = 0;
	// Ids below this watermark are dead. Starts above STALE_ID so an untagged
	// handler is stale even before the first boundary.
	let staleBefore = STALE_ID + 1;

	function begin(): number {
		return ++seq;
	}

	function invalidate(): void {
		staleBefore = ++seq;
	}

	function isLive(id: number): boolean {
		return id >= staleBefore && id <= seq;
	}

	function gateFinal(rawText: unknown, taggedId: number): GateResult {
		const raw = typeof rawText === 'string' ? rawText : '';
		let result: GateResult;
		if (!isLive(taggedId)) {
			result = { decision: 'dropped-stale', text: '' };
		} else {
			const text = raw.trim();
			result =
				text && hasVisibleCharacters(text)
					? { decision: 'accepted', text }
					: { decision: 'dropped-empty', text: '' };
		}
		if (dev) {
			// Length only — never the transcript itself.
			console.debug(`[voice:${path}] final ${result.decision} (id=${taggedId}, len=${raw.length})`);
		}
		return result;
	}

	return { begin, invalidate, isLive, gateFinal };
}
