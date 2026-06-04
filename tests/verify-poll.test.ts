import { describe, it, expect } from 'vitest';
import { posture, buildLedger, type ChannelResult } from '$lib/server/verifyPoll';

const ch = (state: ChannelResult['state'], critical = true): ChannelResult => ({
	channel: 'x',
	state,
	critical,
	detail: '',
	evidence_pointer: state === 'SKIPPED' ? null : 'ptr'
});

describe('posture', () => {
	it('any NO_GO → warn', () => {
		expect(posture([ch('GO'), ch('NO_GO')])).toBe('warn');
	});
	it('UNKNOWN with no NO_GO → hedge', () => {
		expect(posture([ch('GO'), ch('UNKNOWN')])).toBe('hedge');
	});
	it('all GO (SKIPPED ignored) → confirmed', () => {
		expect(posture([ch('GO'), ch('SKIPPED')])).toBe('confirmed');
	});
	it('all SKIPPED/UNKNOWN → hedge, never confirmed', () => {
		expect(posture([ch('UNKNOWN'), ch('SKIPPED')])).toBe('hedge');
	});
	it('liveness-only GO (worker finished, nothing deliverable) → hedge, not confirmed', () => {
		expect(
			posture([
				{
					channel: 'worker_completion',
					state: 'GO',
					critical: true,
					liveness: true,
					detail: '',
					evidence_pointer: 'done'
				}
			])
		).toBe('hedge');
	});
});

describe('buildLedger', () => {
	it('allowed_in_final is true iff GO (I8)', () => {
		const led = buildLedger([ch('GO'), ch('NO_GO'), ch('UNKNOWN'), ch('SKIPPED')]);
		// SKIPPED channels produce no ledger entry
		expect(led).toHaveLength(3);
		expect(led.find((e) => e.verification_status === 'GO')!.allowed_in_final).toBe(true);
		expect(led.find((e) => e.verification_status === 'NO_GO')!.allowed_in_final).toBe(false);
		expect(led.find((e) => e.verification_status === 'UNKNOWN')!.allowed_in_final).toBe(false);
	});
	it('needs_review iff a CRITICAL NO_GO exists', () => {
		expect(buildLedger([ch('NO_GO', true)]).some((e) => e.needs_review)).toBe(true);
		expect(buildLedger([ch('NO_GO', false)]).some((e) => e.needs_review)).toBe(false);
	});
});
