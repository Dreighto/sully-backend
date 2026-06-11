import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	createTranscriptGate,
	hasVisibleCharacters,
	STALE_ID,
	type GateResult
} from '../src/lib/chat/transcript-gate';

// Regression coverage for LOS-203: client-side transcript gating for the two
// voice paths (defense in depth behind the bridge-side fixes for the false
// "Thanks for watching!" chat submissions). These exercise the pure gate the
// controllers depend on — content gating (trim / empty / no visible chars),
// session/turn-id staleness across open/close boundaries, and the dev-gated
// decision log — through a harness wired exactly like the controllers'
// resolver/handler plumbing. The browser-coupled controllers themselves
// (voice.svelte.ts, realtime-voice.svelte.ts) are verified in the Playwright
// WebKit suite + on-device, per the repo's established split.

describe('hasVisibleCharacters — visible-content check behind the trim', () => {
	it('accepts ordinary text, emoji, and accented characters', () => {
		expect(hasVisibleCharacters('hello')).toBe(true);
		expect(hasVisibleCharacters('é')).toBe(true);
		expect(hasVisibleCharacters('👍')).toBe(true);
		expect(hasVisibleCharacters('  a  ')).toBe(true);
	});

	it('rejects whitespace-only and invisible-character-only strings', () => {
		expect(hasVisibleCharacters('')).toBe(false);
		expect(hasVisibleCharacters('   \t\n')).toBe(false);
		// Zero-width space / joiner / non-joiner, word joiner, BOM, soft hyphen —
		// all survive a trim but render as nothing.
		expect(hasVisibleCharacters('​‌‍')).toBe(false);
		expect(hasVisibleCharacters('⁠﻿­')).toBe(false);
		expect(hasVisibleCharacters(' ​ ﻿ ')).toBe(false);
	});
});

describe('createTranscriptGate — id lifecycle (begin / invalidate / isLive)', () => {
	it('ids are monotonically increasing and live until a boundary', () => {
		const gate = createTranscriptGate('talkback');
		const a = gate.begin();
		const b = gate.begin();
		expect(b).toBeGreaterThan(a);
		expect(gate.isLive(a)).toBe(true);
		expect(gate.isLive(b)).toBe(true);
	});

	it('invalidate() stales every previously issued id, new ids are live', () => {
		const gate = createTranscriptGate('talkback');
		const old = gate.begin();
		gate.invalidate();
		expect(gate.isLive(old)).toBe(false);
		const fresh = gate.begin();
		expect(gate.isLive(fresh)).toBe(true);
	});

	it('STALE_ID is never live, even before any boundary', () => {
		const gate = createTranscriptGate('talkback');
		expect(gate.isLive(STALE_ID)).toBe(false);
		gate.begin();
		expect(gate.isLive(STALE_ID)).toBe(false);
	});
});

// Harness mirroring the controllers' wiring exactly: a session id captured at
// socket open (closed over by that connection's message handler), a pending
// per-turn resolver tagged with a fresh turn id, and the gate consulted before
// a `final` may resolve anything. `dispatch` stands in for the POST /api/chat
// (talkback) / /api/chat/voice-reply (realtime) that an accepted final triggers.
function makeVoiceSession() {
	const gate = createTranscriptGate('talkback');
	const dispatched: string[] = [];
	let pending: { id: number; resolve: (text: string) => void } | null = null;
	let sessionId = STALE_ID;

	/** Socket open: capture the connection's session id (gap 2). */
	function openSocket(): number {
		sessionId = gate.begin();
		return sessionId;
	}

	/** Capture-turn start: arm the resolver, tagged with a fresh turn id. */
	function armTurn(): number {
		const id = gate.begin();
		pending = {
			id,
			resolve: (text: string) => {
				pending = null;
				// Mirrors beginTalkbackCapture/dispatchTalkback: only non-empty
				// gated text ever dispatches; an empty resolve just ends the turn.
				if (text) dispatched.push(text);
			}
		};
		return id;
	}

	/**
	 * A `final` frame arrives via the handler of the connection identified by
	 * `viaSessionId` (defaults to the current one; pass an OLD id to simulate a
	 * queued frame from a previous connection). Mirrors onTalkbackWsMessage.
	 */
	function deliverFinal(text: string, viaSessionId = sessionId): GateResult {
		const p = pending;
		const taggedId = p && gate.isLive(viaSessionId) ? p.id : STALE_ID;
		const result = gate.gateFinal(text, taggedId);
		if (result.decision !== 'dropped-stale' && p) p.resolve(result.text);
		return result;
	}

	/** Voice-mode stop / teardown: the staleness boundary + explicit clears. */
	function close(): void {
		gate.invalidate();
		pending = null;
	}

	return {
		dispatched,
		openSocket,
		armTurn,
		deliverFinal,
		close,
		hasPending: () => pending !== null
	};
}

describe('LOS-203 — repeated voice open/close never reuses an old transcript', () => {
	it('a queued final from the OLD connection is stale in the NEW session', () => {
		const session = makeVoiceSession();

		// Session 1: open, arm a turn, but the final is still in flight when the
		// operator closes voice mode.
		const oldSocket = session.openSocket();
		session.armTurn();
		session.close();

		// Session 2: fresh socket, fresh turn.
		session.openSocket();
		session.armTurn();

		// The old connection's queued final lands now — delivered via the OLD
		// session id its handler was tagged with. It must be ignored, not resolve
		// the new session's pending turn.
		const r = session.deliverFinal('Thanks for watching!', oldSocket);
		expect(r.decision).toBe('dropped-stale');
		expect(session.dispatched).toEqual([]);
		expect(session.hasPending()).toBe(true); // new turn untouched, still waiting

		// The new session's own final still flows normally afterwards.
		expect(session.deliverFinal('real utterance').decision).toBe('accepted');
		expect(session.dispatched).toEqual(['real utterance']);
	});

	it('a final arriving AFTER stop never resolves into the next session', () => {
		const session = makeVoiceSession();
		for (let cycle = 0; cycle < 3; cycle++) {
			session.openSocket();
			session.armTurn();
			session.close(); // stop with the turn unresolved
			// Late final from the just-closed session: no pending resolver and a
			// stale connection — dropped on both counts.
			expect(session.deliverFinal('Thanks for watching!').decision).toBe('dropped-stale');
		}
		expect(session.dispatched).toEqual([]);
	});
});

describe('LOS-203 — empty/whitespace finals never dispatch', () => {
	it.each(['', '   ', '\t\n', '​​', ' ﻿ ​ '])(
		'drops %j without dispatching, while still ending the turn',
		(junk) => {
			const session = makeVoiceSession();
			session.openSocket();
			session.armTurn();
			const r = session.deliverFinal(junk);
			expect(r.decision).toBe('dropped-empty');
			expect(r.text).toBe('');
			expect(session.dispatched).toEqual([]);
			// The turn must still RESOLVE (empty) so the talkback loop re-arms
			// instead of hanging until the max-capture timeout.
			expect(session.hasPending()).toBe(false);
		}
	);

	it('drops a non-string final body outright', () => {
		const session = makeVoiceSession();
		session.openSocket();
		session.armTurn();
		expect(session.deliverFinal(undefined as unknown as string).decision).toBe('dropped-empty');
		expect(session.dispatched).toEqual([]);
	});
});

describe('LOS-203 — a valid final dispatches exactly once', () => {
	it('accepts the trimmed text once; a duplicate delivery cannot re-dispatch', () => {
		const session = makeVoiceSession();
		session.openSocket();
		session.armTurn();

		const r = session.deliverFinal('  ship the fix  ');
		expect(r).toEqual({ decision: 'accepted', text: 'ship the fix' });
		expect(session.dispatched).toEqual(['ship the fix']);

		// The same frame replayed (no turn pending any more) is stale — the
		// dispatch count stays at exactly one.
		expect(session.deliverFinal('  ship the fix  ').decision).toBe('dropped-stale');
		expect(session.dispatched).toEqual(['ship the fix']);
	});

	it('an unsolicited final (no capture turn armed) never dispatches', () => {
		const session = makeVoiceSession();
		session.openSocket(); // connected, but no turn started
		expect(session.deliverFinal('unprompted text').decision).toBe('dropped-stale');
		expect(session.dispatched).toEqual([]);
	});
});

describe('LOS-203 — dev-gated decision log', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('emits exactly one console.debug per gated final when dev is on', () => {
		const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
		const gate = createTranscriptGate('realtime', true);
		const id = gate.begin();

		gate.gateFinal('hello there', id);
		gate.gateFinal('   ', id);
		gate.invalidate();
		gate.gateFinal('late one', id);

		expect(debugSpy).toHaveBeenCalledTimes(3);
		const lines = debugSpy.mock.calls.map((c) => String(c[0]));
		expect(lines[0]).toContain('accepted');
		expect(lines[1]).toContain('dropped-empty');
		expect(lines[2]).toContain('dropped-stale');
		// Path, id, and text LENGTH are logged — never the transcript content.
		for (const line of lines) {
			expect(line).toContain('[voice:realtime]');
			expect(line).toMatch(/id=\d+, len=\d+/);
		}
		expect(lines[0]).not.toContain('hello there');
	});

	it('logs nothing when dev is off (the default)', () => {
		const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
		const gate = createTranscriptGate('talkback');
		gate.gateFinal('hello', gate.begin());
		expect(debugSpy).not.toHaveBeenCalled();
	});
});
