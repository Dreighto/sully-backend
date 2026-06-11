// LOS-193 — dispatched-run fixture renders the RunSheet. SSR-renders the
// component with the same rows/status shape the dispatch stream delivers and
// asserts the sheet regions (timeline / gates / collapsed log row / files),
// the operator-locked truth guards (absent data = absent row, skipped ≠ done,
// no fake done while running), and the dismiss affordances. Source-level
// checks pin the pill→sheet tap wiring.
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import RunSheet from '$lib/work-surface/pill/RunSheet.svelte';
import WorkerPill from '$lib/work-surface/pill/WorkerPill.svelte';

const liveRun = {
	traceId: 'sully-fixture-193',
	rows: [
		{ seq: 1, action: 'reading', target: 'src/app.css' },
		{ seq: 2, action: 'edited', target: 'src/app.css' },
		{ seq: 3, action: 'verification_poll', target: '{"overall":"GO"}' }
	],
	status: 'working',
	worker: 'claude-code',
	brief: 'Audit the docs folder',
	startedAtIso: new Date(Date.now() - 95_000).toISOString(),
	durationLabel: null,
	onclose: () => {}
};

describe('RunSheet SSR (dispatched-run fixture)', () => {
	it('renders the sheet shell with worker · title · state · elapsed', () => {
		const { body } = render(RunSheet, { props: liveRun });
		expect(body).toContain('data-testid="run-sheet"');
		expect(body).toContain('data-aggr="running"');
		expect(body).toContain('data-trace-id="sully-fixture-193"');
		expect(body).toContain('data-testid="run-sheet-worker"');
		expect(body).toContain('>CC');
		expect(body).toContain('data-testid="run-sheet-title"');
		expect(body).toContain('Audit the docs folder');
		expect(body).toContain('data-testid="run-sheet-state"');
		expect(body).toContain('data-testid="run-sheet-elapsed"');
		expect(body).toMatch(/1m3[0-9]s/);
		// Header state animation: trusted live run hosts the Lottie at sheet scale.
		expect(body).toContain('data-testid="run-sheet-anim"');
	});

	it('step timeline renders all six stages with honest statuses', () => {
		const { body } = render(RunSheet, { props: liveRun });
		expect(body.match(/data-testid="run-sheet-step"/g)).toHaveLength(6);
		expect(body).toContain('data-stage="read" data-status="done"');
		// Skipped ≠ done: Research saw no activity below the Check frontier.
		expect(body).toContain('data-stage="research" data-status="skipped"');
		expect(body).toContain('data-stage="check" data-status="active"');
		expect(body).toContain('data-stage="reply" data-status="pending"');
	});

	it('gate badges render from verification rows in the stream', () => {
		const { body } = render(RunSheet, { props: liveRun });
		expect(body).toContain('data-testid="run-sheet-gates"');
		expect(body).toContain('data-kind="verify" data-verdict="go"');
		expect(body).toContain('Verified — looks good');
		// The raw JSON payload never leaks into markup.
		expect(body).not.toContain('{&quot;overall&quot;');
		expect(body).not.toContain('"overall"');
	});

	it('no gate rows → no gates section at all (absent data = absent row)', () => {
		const { body } = render(RunSheet, {
			props: { ...liveRun, rows: [{ seq: 1, action: 'reading', target: 'src/app.css' }] }
		});
		expect(body).not.toContain('data-testid="run-sheet-gates"');
	});

	it('log renders collapsed by default — one row, count + latest line, list closed', () => {
		const { body } = render(RunSheet, { props: liveRun });
		expect(body).toContain('data-testid="run-sheet-log-row"');
		expect(body).toContain('aria-expanded="false"');
		expect(body).toContain('3 steps');
		// Latest line shows; the expanded chronological list does not.
		expect(body).toContain('Verified — looks good');
		expect(body).not.toContain('data-testid="run-sheet-log-entry"');
	});

	it('zero displayable rows → no log section at all', () => {
		const { body } = render(RunSheet, { props: { ...liveRun, rows: [] } });
		expect(body).not.toContain('data-testid="run-sheet-log-row"');
	});

	it('result-files row only when files exist (operator-locked truth guard)', () => {
		const withFiles = render(RunSheet, { props: liveRun });
		expect(withFiles.body).toContain('data-testid="run-sheet-files"');
		expect(withFiles.body).toContain('src/app.css');

		const noFiles = render(RunSheet, {
			props: { ...liveRun, rows: [{ seq: 1, action: 'reading', target: 'src/app.css' }] }
		});
		expect(noFiles.body).not.toContain('data-testid="run-sheet-files"');
	});

	it('no fake done while running: live sheet shows neither done aggr nor done state label', () => {
		const { body } = render(RunSheet, { props: liveRun });
		expect(body).toContain('data-aggr="running"');
		expect(body).not.toContain('data-aggr="done"');
		expect(body).not.toContain('rs-state--done');
	});

	it('terminal sheet keeps its lanes — dimmed truth, frozen duration, stages persist', () => {
		const { body } = render(RunSheet, {
			props: { ...liveRun, status: 'synthesized', durationLabel: '4 min' }
		});
		expect(body).toContain('data-aggr="done"');
		expect(body).toContain('4 min');
		// Lanes persist: all six timeline rows still render at terminal.
		expect(body.match(/data-testid="run-sheet-step"/g)).toHaveLength(6);
	});

	it('stopped reads neutral — not failed', () => {
		const { body } = render(RunSheet, { props: { ...liveRun, status: 'aborted' } });
		expect(body).toContain('data-aggr="stopped"');
		expect(body).not.toContain('data-aggr="failed"');
	});

	it('unreconciled run renders "checking…" instead of a live clock (LOS-196 carry-over)', () => {
		const { body } = render(RunSheet, { props: { ...liveRun, reconciled: false } });
		expect(body).toContain('data-trust="unverified"');
		expect(body).toContain('data-testid="run-sheet-checking"');
		expect(body).not.toContain('data-testid="run-sheet-elapsed"');
		// Truth guard carries to the header animation: unverified wears no motion.
		expect(body).not.toContain('data-testid="run-sheet-anim"');
	});

	it('dismiss affordances exist: scrim, close button, drag handle on the sheet', () => {
		const { body } = render(RunSheet, { props: liveRun });
		expect(body).toContain('data-testid="run-sheet-scrim"');
		expect(body).toContain('aria-label="Close run details"');
		expect(body).toContain('data-sheet');
		expect(body).toContain('role="dialog"');
		expect(body).toContain('aria-modal="true"');
	});
});

describe('WorkerPill tap wiring (LOS-193)', () => {
	it('the pill is a button that opens the run sheet — closed by default', () => {
		const { body } = render(WorkerPill, {
			props: {
				traceId: 'sully-fixture-193',
				rows: liveRun.rows,
				status: 'working',
				worker: 'claude-code',
				brief: 'Audit the docs folder',
				startedAtIso: liveRun.startedAtIso,
				durationLabel: null
			}
		});
		expect(body).toContain('data-testid="worker-pill"');
		expect(body).toContain('aria-haspopup="dialog"');
		expect(body).toContain('aria-expanded="false"');
		// Sheet only mounts on tap — never pre-rendered.
		expect(body).not.toContain('data-testid="run-sheet"');
	});

	it('WorkerPill mounts RunSheet behind the tap (source-level)', async () => {
		const fs = await import('node:fs');
		const src = fs.readFileSync('src/lib/work-surface/pill/WorkerPill.svelte', 'utf-8');
		expect(src).toContain("import RunSheet from './RunSheet.svelte'");
		expect(src).toContain('<RunSheet');
		expect(src).toContain('sheetOpen = true');
		expect(src).toMatch(/<button[\s\S]*data-testid="worker-pill"/);
	});

	it('RunSheet uses the shared createSheetDrag factory + locked sheet motion tokens', async () => {
		const fs = await import('node:fs');
		const src = fs.readFileSync('src/lib/work-surface/pill/RunSheet.svelte', 'utf-8');
		expect(src).toContain("import { createSheetDrag } from '$lib/utils/sheetDrag.svelte'");
		expect(src).toContain('--ease-sheet');
		expect(src).toContain('--dur-panel');
		expect(src).toContain('--dur-long');
		expect(src).toContain('prefers-reduced-motion');
		// Zero raw hexes outside tokens — locked palette only.
		expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	});

	it('quarantined hybrid module stays untouched on disk', async () => {
		const fs = await import('node:fs');
		for (const kept of [
			'src/lib/work-surface/hybrid/HybridSurfaceMount.svelte',
			'src/lib/work-surface/hybrid/HybridDetailSheet.svelte'
		]) {
			expect(fs.existsSync(kept), `${kept} must remain on disk`).toBe(true);
		}
	});
});
