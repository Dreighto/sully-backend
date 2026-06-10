// Pure, browser-API-free helpers for the local STT WebSocket bridge that the
// in-composer Talkback loop now routes through:
//
//   mic → WS `/companion-voice` → `logueos-companion-stt.service` (:18770)
//        → Jetson unified voice service (http://10.10.10.2:18780)
//
// These are factored OUT of `voice.svelte.ts` so the talkback transport's
// message-parsing / stop-word / URL logic is unit-testable in the node test
// env. The controller itself is browser-coupled (WebSocket, AudioWorklet,
// getUserMedia, AudioContext) and can only be exercised in a real browser /
// the Playwright WebKit suite.

export type SttMessageType = 'ready' | 'partial' | 'final' | 'error' | 'ignore';

export interface SttMessage {
	type: SttMessageType;
	/** Present on 'partial' / 'final'. */
	text?: string;
	/** Present on 'error'. */
	error?: string;
}

/**
 * Parse a raw STT WebSocket message into a normalized shape. NEVER throws:
 * a non-string payload, malformed JSON, a non-object body, or an unrecognized
 * `type` all collapse to `{ type: 'ignore' }`. This is the boundary that keeps
 * a noisy / unexpected socket message from ever surfacing as a transcript —
 * and, by extension, keeps talkback from silently acting on garbage.
 */
export function parseSttMessage(data: unknown): SttMessage {
	if (typeof data !== 'string') return { type: 'ignore' };
	let m: { type?: unknown; text?: unknown; error?: unknown };
	try {
		m = JSON.parse(data) as typeof m;
	} catch {
		return { type: 'ignore' };
	}
	if (!m || typeof m !== 'object') return { type: 'ignore' };
	const text = typeof m.text === 'string' ? m.text : undefined;
	switch (m.type) {
		case 'ready':
			return { type: 'ready' };
		case 'partial':
			return { type: 'partial', text };
		case 'final':
			return { type: 'final', text };
		case 'error':
			return {
				type: 'error',
				error: typeof m.error === 'string' ? m.error : 'Speech recognition error.'
			};
		default:
			return { type: 'ignore' };
	}
}

// Spoken phrases that end the hands-free talkback loop (case-insensitive,
// substring match so they fire even mid-sentence).
const STOP_PHRASES = ['stop talkback', 'cancel talkback'] as const;

/** True if a transcript contains a talkback stop phrase (case-insensitive). */
export function isTalkbackStopWord(transcript: string): boolean {
	const lower = transcript.toLowerCase();
	return STOP_PHRASES.some((p) => lower.includes(p));
}

/**
 * Build the STT WebSocket URL from the page location and the configured root
 * Funnel path. `wsPath` is a ROOT path (a sibling of the app's base), so it is
 * deliberately NOT run through SvelteKit's `resolve()` — that would wrongly
 * prepend the app base. `wss` for an https page, `ws` otherwise.
 */
export function buildVoiceWsUrl(protocol: string, host: string, wsPath: string): string {
	const proto = protocol === 'https:' ? 'wss' : 'ws';
	return `${proto}://${host}${wsPath}`;
}
