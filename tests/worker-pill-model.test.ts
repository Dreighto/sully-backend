// LOS-192 — collapsed worker pill view-model. Locks the truth guards:
// no fake done while running, skipped ≠ done, stopped ≠ failed, and the
// stage-dot frontier rules mirrored from the server's buildPhases.
import { describe, expect, it } from 'vitest';
import {
	mapStreamStatusToAggr,
	isTerminalAggr,
	deriveStageDots,
	pillWorker,
	fmtElapsed,
	parsePillTs,
	derivePillTrust,
	PILL_STALE_CAP_MS
} from '$lib/work-surface/pill/pillModel';
import type { StreamRow } from '$lib/chat/dispatchReconcile';

function rowsFor(actions: string[]): StreamRow[] {
	return actions.map((action, i) => ({ seq: i + 1, action, target: null }));
}

describe('mapStreamStatusToAggr', () => {
	it('maps every in-flight job status to running — never done', () => {
		for (const s of ['proposed', 'classified', 'decided', 'dispatched', 'working', 'retry']) {
			expect(mapStreamStatusToAggr(s)).toBe('running');
		}
	});

	it('maps gated/held to needs-you', () => {
		expect(mapStreamStatusToAggr('gated')).toBe('needs-you');
		expect(mapStreamStatusToAggr('held')).toBe('needs-you');
	});

	it('maps all success terminals to done', () => {
		for (const s of ['done', 'verified', 'synthesized']) {
			expect(mapStreamStatusToAggr(s)).toBe('done');
		}
	});

	it('keeps stopped (aborted) distinct from failed', () => {
		expect(mapStreamStatusToAggr('aborted')).toBe('stopped');
		expect(mapStreamStatusToAggr('failed')).toBe('failed');
	});

	it('defaults unknown statuses to running (no fake done)', () => {
		expect(mapStreamStatusToAggr('some_future_status')).toBe('running');
	});
});

describe('isTerminalAggr', () => {
	it('only done/failed/stopped are terminal', () => {
		expect(isTerminalAggr('done')).toBe(true);
		expect(isTerminalAggr('failed')).toBe(true);
		expect(isTerminalAggr('stopped')).toBe(true);
		expect(isTerminalAggr('running')).toBe(false);
		expect(isTerminalAggr('needs-you')).toBe(false);
		expect(isTerminalAggr('blocked')).toBe(false);
	});
});

describe('deriveStageDots', () => {
	const keys = (dots: ReturnType<typeof deriveStageDots>) => dots.map((d) => d.key);
	const statuses = (dots: ReturnType<typeof deriveStageDots>) => dots.map((d) => d.status);

	it('always returns the six pipeline stages in order', () => {
		const dots = deriveStageDots([], 'running');
		expect(keys(dots)).toEqual(['read', 'research', 'build', 'check', 'approve', 'reply']);
	});

	it('zero activity while running → Read is the implicit active stage', () => {
		const dots = deriveStageDots([], 'running');
		expect(statuses(dots)).toEqual([
			'active',
			'pending',
			'pending',
			'pending',
			'pending',
			'pending'
		]);
	});

	it('Read→Build run in flight: Research (no activity) is skipped, never done', () => {
		const dots = deriveStageDots(rowsFor(['reading', 'edited']), 'running');
		expect(statuses(dots)).toEqual(['done', 'skipped', 'active', 'pending', 'pending', 'pending']);
	});

	it('no fake done while running: frontier stays active even after check-stage actions', () => {
		const dots = deriveStageDots(rowsFor(['reading', 'edited', 'verification_poll']), 'running');
		expect(statuses(dots)).toEqual(['done', 'skipped', 'done', 'active', 'pending', 'pending']);
		expect(dots.every((d) => d.status !== 'done' || d.key !== 'check')).toBe(true);
	});

	it('terminal done: frontier is done, unreached stages are skipped (not pending)', () => {
		const dots = deriveStageDots(rowsFor(['reading', 'shell']), 'done');
		expect(statuses(dots)).toEqual(['done', 'skipped', 'done', 'skipped', 'skipped', 'skipped']);
	});

	it('failed run marks the frontier failed', () => {
		const dots = deriveStageDots(rowsFor(['reading', 'ran']), 'failed');
		expect(dots[2]).toEqual({ key: 'build', status: 'failed' });
		expect(statuses(dots).slice(3)).toEqual(['skipped', 'skipped', 'skipped']);
	});

	it('stopped run marks the frontier skipped — neutral, not done and not failed', () => {
		const dots = deriveStageDots(rowsFor(['reading', 'tool_invoked']), 'stopped');
		expect(dots[2]).toEqual({ key: 'build', status: 'skipped' });
		expect(statuses(dots)).not.toContain('failed');
	});

	it('needs-you surfaces on the frontier dot', () => {
		const dots = deriveStageDots(rowsFor(['thinking']), 'needs-you');
		expect(dots[0]).toEqual({ key: 'read', status: 'needs-you' });
	});

	it('ignores actions with no stage mapping', () => {
		const dots = deriveStageDots(rowsFor(['some_unmapped_action']), 'running');
		expect(statuses(dots)).toEqual([
			'active',
			'pending',
			'pending',
			'pending',
			'pending',
			'pending'
		]);
	});
});

describe('pillWorker', () => {
	it('prefers the job row worker id', () => {
		expect(pillWorker('antigravity', 'sully-x')).toEqual({
			shortCode: 'AGY',
			display: 'Antigravity'
		});
		expect(pillWorker('claude-code', 'sully-agy-x')).toEqual({
			shortCode: 'CC',
			display: 'Claude Code'
		});
	});

	it('falls back to trace-id sniffing before the job row arrives', () => {
		expect(pillWorker(null, 'sully-agy-123').shortCode).toBe('AGY');
		expect(pillWorker(null, 'sully-gemini-123').shortCode).toBe('GMI');
		expect(pillWorker(null, 'sully-123').shortCode).toBe('CC');
	});

	it('renders an unknown worker id as itself — never silently CC (LOS-205)', () => {
		expect(pillWorker('mystery-bot', 'sully-123')).toEqual({
			shortCode: 'MYST',
			display: 'mystery-bot'
		});
	});
});

describe('fmtElapsed', () => {
	it('formats seconds, minutes and hours compactly', () => {
		expect(fmtElapsed(42_000)).toBe('42s');
		expect(fmtElapsed(192_000)).toBe('3m12s');
		expect(fmtElapsed(3_840_000)).toBe('1h04m');
	});

	it('is empty for invalid input', () => {
		expect(fmtElapsed(-5)).toBe('');
		expect(fmtElapsed(Number.NaN)).toBe('');
	});
});

describe('parsePillTs', () => {
	it('treats unmarked SQLite timestamps as UTC', () => {
		expect(parsePillTs('2026-06-10 12:00:00')).toBe(Date.parse('2026-06-10T12:00:00Z'));
	});

	it('passes through ISO strings with zone markers', () => {
		expect(parsePillTs('2026-06-10T12:00:00Z')).toBe(Date.parse('2026-06-10T12:00:00Z'));
	});

	it('is NaN for null/empty', () => {
		expect(Number.isNaN(parsePillTs(null))).toBe(true);
		expect(Number.isNaN(parsePillTs(''))).toBe(true);
	});
});

// LOS-196 truth guards: no fake running on mount, no fake running after done.
describe('derivePillTrust', () => {
	const now = Date.parse('2026-06-10T22:00:00Z');
	const startedAgo = (ms: number) => new Date(now - ms).toISOString();

	it('always trusts a terminal status — reconciled or not', () => {
		expect(
			derivePillTrust({ terminal: true, reconciled: false, startedAtIso: null, nowMs: now })
		).toBe('trusted');
		expect(
			derivePillTrust({
				terminal: true,
				reconciled: true,
				startedAtIso: startedAgo(PILL_STALE_CAP_MS * 3),
				nowMs: now
			})
		).toBe('trusted');
	});

	it('is unverified until the first successful reconcile', () => {
		expect(
			derivePillTrust({
				terminal: false,
				reconciled: false,
				startedAtIso: startedAgo(60_000),
				nowMs: now
			})
		).toBe('unverified');
	});

	it('trusts a reconciled non-terminal run under the cap', () => {
		expect(
			derivePillTrust({
				terminal: false,
				reconciled: true,
				startedAtIso: startedAgo(60_000),
				nowMs: now
			})
		).toBe('trusted');
	});

	it('goes stale past the max-elapsed cap (the 1h27m phantom-run case)', () => {
		expect(
			derivePillTrust({
				terminal: false,
				reconciled: true,
				startedAtIso: startedAgo(87 * 60 * 1000),
				nowMs: now
			})
		).toBe('stale');
		// Boundary: exactly at the cap is still trusted; just past it is stale.
		expect(
			derivePillTrust({
				terminal: false,
				reconciled: true,
				startedAtIso: startedAgo(PILL_STALE_CAP_MS),
				nowMs: now
			})
		).toBe('trusted');
		expect(
			derivePillTrust({
				terminal: false,
				reconciled: true,
				startedAtIso: startedAgo(PILL_STALE_CAP_MS + 1000),
				nowMs: now
			})
		).toBe('stale');
	});

	it('never goes stale without a parseable start timestamp', () => {
		expect(
			derivePillTrust({ terminal: false, reconciled: true, startedAtIso: null, nowMs: now })
		).toBe('trusted');
	});

	it('honors a custom cap', () => {
		expect(
			derivePillTrust({
				terminal: false,
				reconciled: true,
				startedAtIso: startedAgo(10_000),
				nowMs: now,
				capMs: 5_000
			})
		).toBe('stale');
	});
});
