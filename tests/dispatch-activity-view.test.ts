import { describe, it, expect } from 'vitest';
import {
	friendlyStep,
	isTerminalStatus,
	isSuccessStatus,
	DISPLAYABLE_WORKER_ACTIONS
} from '$lib/dispatchActivityView';

describe('friendlyStep', () => {
	it('maps real worker steps to plain English', () => {
		expect(friendlyStep('ran', 'tests')).toMatch(/running/i);
		expect(friendlyStep('reading', 'src/app.ts')).toMatch(/reading/i);
		expect(friendlyStep('edited', null)).toMatch(/chang|edit|updat/i);
		expect(friendlyStep('thinking', null)).toMatch(/work|think/i);
	});
	it('drops internal pipeline events (no leak)', () => {
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
			'guardrail_triggered'
		])
			expect(friendlyStep(a, '{"x":1}')).toBeNull();
	});
	it('never returns raw JSON or event names', () => {
		expect(friendlyStep('ran', '{"outcome":"done","via":"worker-result"}') ?? '').not.toContain(
			'{'
		);
		expect(friendlyStep('synthesis_completed', '{"outcome":"done"}')).toBeNull();
	});
	it('only the four worker actions are displayable', () => {
		expect([...DISPLAYABLE_WORKER_ACTIONS].sort()).toEqual(
			['edited', 'ran', 'reading', 'thinking'].sort()
		);
	});
});

describe('isTerminalStatus / isSuccessStatus', () => {
	it('treats synthesized + verified as terminal (the P1 stuck-timer fix)', () => {
		for (const s of ['done', 'failed', 'aborted', 'synthesized', 'verified'])
			expect(isTerminalStatus(s)).toBe(true);
		for (const s of ['working', 'dispatched', 'decided', 'gated', 'proposed', 'classified'])
			expect(isTerminalStatus(s)).toBe(false);
	});
	it('classifies success vs failure terminals', () => {
		for (const s of ['done', 'verified', 'synthesized']) expect(isSuccessStatus(s)).toBe(true);
		for (const s of ['failed', 'aborted']) expect(isSuccessStatus(s)).toBe(false);
	});
});
