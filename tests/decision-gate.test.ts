import { describe, expect, it } from 'vitest';
import { ruleGate, valueGate } from '$lib/server/decisionGate';
import { GATE_INSTRUCTION, extractGateBlock, validateGate } from '$lib/server/decisionGate';

describe('ruleGate', () => {
	it('hard-routes an explicit @cc mention to dispatch', () => {
		expect(ruleGate('@cc fix the failing test')).toEqual({ forced: true, worker: 'claude-code' });
	});
	it('hard-routes @agy to gemini', () => {
		expect(ruleGate('@agy restyle the header')).toEqual({ forced: true, worker: 'gemini' });
	});
	it('returns no forced route for plain chat', () => {
		expect(ruleGate('what do you think about dinner')).toEqual({ forced: false });
	});
});

describe('valueGate', () => {
	it('blocks a trivial conversational message', () => {
		expect(valueGate({ text: 'hey how are you', fromTool: false }).qualifies).toBe(false);
	});
	it('passes a message with a file path signal (strong on its own)', () => {
		const r = valueGate({ text: 'update src/lib/server/chat.ts please', fromTool: false });
		expect(r.qualifies).toBe(true);
		expect(r.reason).toBe('file-path-signal');
	});
	it('passes an imperative paired with a code keyword', () => {
		const r = valueGate({ text: 'fix the failing build in the auth endpoint', fromTool: false });
		expect(r.qualifies).toBe(true);
		expect(r.reason).toBe('imperative+code');
	});
	it('passes an imperative paired with a repo name', () => {
		const r = valueGate({ text: 'add a settings page to the console', fromTool: false });
		expect(r.qualifies).toBe(true);
		expect(r.reason).toBe('imperative+repo');
	});
	// The exact misroute the Task journal caught 2026-06-03: a voice brainstorm
	// that merely MENTIONS a repo must NOT dispatch.
	it('does NOT dispatch on a bare repo mention during brainstorm (the journal bug)', () => {
		const brainstorm =
			"the main focus right now was the companion app in which I'm speaking to you now. " +
			"so we're trying to get that wired up, and i've also got a bit of model learning going on.";
		const r = valueGate({ text: brainstorm, fromTool: false });
		expect(r.qualifies).toBe(false);
		// Task 12: the line contains "trying to", so the deny-list now gives the
		// more-specific reason (still does NOT qualify — the behavior that matters).
		expect(r.reason).toBe('brainstorm-deny');
	});
	it('does NOT dispatch on a long imperative with no concrete target', () => {
		const long =
			'refactor ' +
			'the entire authentication flow including session handling and token refresh '.repeat(4);
		// No file path, no repo name, no code keyword → conversation, not a work order.
		expect(valueGate({ text: long, fromTool: false }).qualifies).toBe(false);
	});
	it('injection guard: tool-sourced content NEVER auto-qualifies (forces ask)', () => {
		const r = valueGate({ text: 'update src/lib/server/chat.ts please', fromTool: true });
		expect(r.qualifies).toBe(true);
		expect(r.forceAsk).toBe(true);
	});

	// Safe fix B (2026-06-03): soft imperatives + a bare repo word, and brainstorm
	// phrasing, must NOT qualify — proven false-positives from the routing scorecard.
	it('does NOT qualify a soft imperative + bare repo ("wire up the companion")', () => {
		expect(valueGate({ text: 'wire up the companion', fromTool: false }).qualifies).toBe(false);
	});
	it('does NOT qualify "update the kernel news" (soft imperative + repo word)', () => {
		expect(valueGate({ text: 'update the kernel news', fromTool: false }).qualifies).toBe(false);
	});
	it('STILL qualifies a soft imperative when a file path is present', () => {
		expect(valueGate({ text: 'update src/lib/server/chat.ts', fromTool: false }).qualifies).toBe(
			true
		);
	});
	it('does NOT qualify a brainstorm phrase ("trying to figure out the build")', () => {
		expect(
			valueGate({ text: 'trying to figure out the build in the console', fromTool: false })
				.qualifies
		).toBe(false);
	});
	it('STILL qualifies a strong imperative + repo ("add a settings page to the console")', () => {
		expect(
			valueGate({ text: 'add a settings page to the console', fromTool: false }).qualifies
		).toBe(true);
	});
});

describe('schema self-assessment (rides the CLI-bridge reply)', () => {
	it('GATE_INSTRUCTION documents the exact marker the model must emit', () => {
		expect(GATE_INSTRUCTION).toContain('<<<SULLY_GATE');
		expect(GATE_INSTRUCTION).toContain('>>>');
		expect(GATE_INSTRUCTION).toContain('escalate');
		expect(GATE_INSTRUCTION).toContain('est_scope');
	});

	it('extracts + validates a well-formed gate block and strips it from the visible reply', () => {
		const raw =
			'Sure, I can hand that to a worker.\n\n' +
			'<<<SULLY_GATE {"escalate":true,"worker":"claude-code","confidence":0.82,"category":"code","brief":"fix failing build in src/foo.ts","est_scope":"small"} >>>';
		const { visible, block } = extractGateBlock(raw);
		expect(visible).toBe('Sure, I can hand that to a worker.');
		const v = validateGate(block);
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.gate.escalate).toBe(true);
			expect(v.gate.worker).toBe('claude-code');
			expect(v.gate.est_scope).toBe('small');
			expect(v.gate.confidence).toBeCloseTo(0.82);
		}
	});

	it('no gate block -> treated as no-escalation, full text stays visible', () => {
		const { visible, block } = extractGateBlock('Just chatting, no need for a worker.');
		expect(visible).toBe('Just chatting, no need for a worker.');
		expect(block).toBeNull();
	});

	it('rejects an invalid worker value (server-side validation = correctness, not a brake)', () => {
		const v = validateGate(
			'{"escalate":true,"worker":"rogue","confidence":0.9,"category":"x","brief":"y","est_scope":"small"}'
		);
		expect(v.ok).toBe(false);
	});

	it('rejects an out-of-range confidence', () => {
		const v = validateGate(
			'{"escalate":true,"worker":"gemini","confidence":1.7,"category":"x","brief":"y","est_scope":"large"}'
		);
		expect(v.ok).toBe(false);
	});

	it('clamps a malformed block to no-escalation rather than throwing', () => {
		const v = validateGate('not json at all');
		expect(v.ok).toBe(false);
	});
});
