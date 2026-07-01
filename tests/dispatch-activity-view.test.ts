import { describe, it, expect } from 'vitest';
import {
	friendlyStep,
	isTerminalStatus,
	isSuccessStatus,
	isDisplayableAction,
	HIDDEN_ACTIONS
} from '$lib/dispatchActivityView';

describe('friendlyStep', () => {
	it('maps real worker steps to plain English (both tenses)', () => {
		// The real worker emits present-tense verbs ('running', not 'ran').
		expect(friendlyStep('running', 'npm test (vitest run)')).toMatch(/running/i);
		expect(friendlyStep('ran', 'tests')).toMatch(/running/i);
		expect(friendlyStep('reading', 'src/app.ts')).toMatch(/reading/i);
		expect(friendlyStep('edited', null)).toMatch(/chang|edit|updat/i);
		expect(friendlyStep('thinking', null)).toMatch(/work|think/i);
	});
	it('drops internal pipeline events + terminal markers (no leak)', () => {
		for (const a of [
			'synthesis_completed',
			'synthesis_started',
			'gate_evaluated',
			'task_proposed',
			'classifier_ran',
			'reply_persisted',
			'tool_invoked',
			'tool_result',
			'provider_attempted',
			'provider_fell_through',
			'brakes_evaluated',
			'guardrail_triggered',
			'completed',
			'failed'
		])
			expect(friendlyStep(a, '{"x":1}')).toBeNull();
	});
	it('an unknown verb falls back to a generic phrase, never the raw verb/target', () => {
		const out = friendlyStep('frobnicating', '/secret/path {"k":"v"}') ?? '';
		expect(out).not.toContain('{');
		expect(out).not.toContain('frobnicating');
		expect(out).not.toContain('/secret/path');
		expect(out.length).toBeGreaterThan(0);
	});
	it('never returns raw JSON for a known verb either', () => {
		expect(friendlyStep('ran', '{"outcome":"done","via":"worker-result"}') ?? '').not.toContain(
			'{'
		);
	});
	it('isDisplayableAction hides every HIDDEN_ACTION and shows worker verbs', () => {
		for (const a of HIDDEN_ACTIONS) expect(isDisplayableAction(a)).toBe(false);
		for (const a of ['running', 'reading', 'edited', 'thinking', 'frobnicating'])
			expect(isDisplayableAction(a)).toBe(true);
	});
});

describe('isTerminalStatus / isSuccessStatus', () => {
	it('holds done/verified as pre-synthesis progress; only synthesized/failed/aborted are terminal (the P1 premature-close fix)', () => {
		// A genuine SINK terminates: success ('synthesized' = reply row written) or
		// failure ('failed'/'aborted'). 'done'/'verified' are worker-finished-but-
		// PRE-synthesis, so they are NON-terminal here — the SSE terminal gate holds
		// (mirroring the poll route) until 'synthesized', or the 90s safety cap fires.
		for (const s of ['synthesized', 'failed', 'aborted']) expect(isTerminalStatus(s)).toBe(true);
		for (const s of [
			'done',
			'verified',
			'working',
			'dispatched',
			'decided',
			'gated',
			'proposed',
			'classified'
		])
			expect(isTerminalStatus(s)).toBe(false);
	});
	it('classifies success vs failure terminals', () => {
		for (const s of ['done', 'verified', 'synthesized']) expect(isSuccessStatus(s)).toBe(true);
		for (const s of ['failed', 'aborted']) expect(isSuccessStatus(s)).toBe(false);
	});
});
