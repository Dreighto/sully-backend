// pillAnimFor — working-state Lottie selection (icon-wiring pass).
// The truth-guard rules matter more than the file names: no motion on
// unverified/stale pills, no motion on stopped, terminal anims don't loop.
import { describe, expect, it } from 'vitest';
import { BRAND_REVEALS, pillAnimFor, type PillStage } from '../src/lib/work-surface/pill/pillModel';
import { WORKER_TEMPLATES } from '../src/lib/work-surface/chatBridge.svelte';

const stages = (active: string | null): PillStage[] =>
	['read', 'research', 'build', 'check', 'approve', 'reply'].map((key) => ({
		key: key as PillStage['key'],
		status: key === active ? 'active' : 'pending'
	}));

describe('pillAnimFor', () => {
	it('renders NO animation unless the run is trusted (truth guard)', () => {
		for (const trust of ['unverified', 'stale'] as const) {
			expect(
				pillAnimFor({ status: 'working', aggr: 'running', stages: stages('build'), trust })
			).toBeNull();
		}
	});

	it('renders NO animation for stopped — neutral terminal', () => {
		expect(
			pillAnimFor({ status: 'aborted', aggr: 'stopped', stages: stages(null), trust: 'trusted' })
		).toBeNull();
	});

	it('maps pre-flight statuses to planning', () => {
		for (const status of ['proposed', 'classified', 'decided']) {
			expect(
				pillAnimFor({ status, aggr: 'running', stages: stages(null), trust: 'trusted' })?.file
			).toBe('state-planning-v4.json');
		}
	});

	it('maps dispatched / retry / opening_pr / merged to their own moments', () => {
		const cases: Array<[string, string]> = [
			['dispatched', 'worker-dispatched-ping.json'],
			['retry', 'state-retry-elastic.json'],
			['opening_pr', 'state-opening-pr-v4.json'],
			['merged', 'state-merged-v4.json']
		];
		for (const [status, file] of cases) {
			expect(
				pillAnimFor({ status, aggr: 'running', stages: stages('build'), trust: 'trusted' })?.file
			).toBe(file);
		}
	});

	it('working = orbit on build stages, verifying scan on check/approve frontier', () => {
		expect(
			pillAnimFor({ status: 'working', aggr: 'running', stages: stages('build'), trust: 'trusted' })
				?.file
		).toBe('worker-active-orbit.json');
		for (const frontier of ['check', 'approve']) {
			expect(
				pillAnimFor({
					status: 'working',
					aggr: 'running',
					stages: stages(frontier),
					trust: 'trusted'
				})?.file
			).toBe('worker-verifying-scan.json');
		}
	});

	it('needs-you/blocked breathe amber; done/failed play once and HOLD (loop=false)', () => {
		expect(
			pillAnimFor({ status: 'gated', aggr: 'needs-you', stages: stages(null), trust: 'trusted' })
		).toEqual({ file: 'worker-waiting-breath.json', loop: true });
		const done = pillAnimFor({
			status: 'done',
			aggr: 'done',
			stages: stages(null),
			trust: 'trusted'
		});
		const failed = pillAnimFor({
			status: 'failed',
			aggr: 'failed',
			stages: stages(null),
			trust: 'trusted'
		});
		expect(done).toEqual({ file: 'worker-done-check.json', loop: false });
		expect(failed).toEqual({ file: 'worker-failed-x.json', loop: false });
	});
});

describe('BRAND_REVEALS', () => {
	it('covers every roster identity in WORKER_TEMPLATES (intro never dangles)', () => {
		for (const tpl of Object.values(WORKER_TEMPLATES)) {
			expect(BRAND_REVEALS[tpl.shortCode], `missing reveal for ${tpl.shortCode}`).toBeTruthy();
		}
	});
});
