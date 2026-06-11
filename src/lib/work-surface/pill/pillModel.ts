// Pill view-model — pure derivation from the EXISTING dispatch stream
// (createDispatchStream rows/status/job fields) to what the collapsed worker
// pill renders: aggregate state, six stage dots, worker identity, elapsed.
//
// This is a client-side mirror of the truth rules in
// src/lib/server/surfaceAdapter.ts (mapJobStatusToAggrStatus + buildPhases),
// operating on the deny-list-filtered rows the stream actually delivers.
// Truth guards (operator-locked, LOS-192):
//   - aggr derives ONLY from the job/stream status — no fake done while running
//   - a stage with no activity below the frontier is 'skipped', never 'done'
//   - 'stopped' (operator abort) is neutral-terminal, distinct from 'failed'
import type { StreamRow } from '$lib/chat/dispatchReconcile';
import type { AggrStatus, PhaseKey, PhaseStatus } from '$lib/work-surface/hybrid/hybrid-types';
import { WORKER_TEMPLATES, inferStageFromAction } from '$lib/work-surface/chatBridge.svelte';

export interface PillStage {
	key: PhaseKey;
	status: PhaseStatus;
}

export interface PillWorker {
	shortCode: string;
	display: string;
}

const PIPELINE_STAGES = ['Read', 'Research', 'Build', 'Check', 'Approve', 'Reply'] as const;

/** Client mirror of the server's mapJobStatusToAggrStatus, plus the stream's
 *  own 'working' default and terminal-frame vocabulary. */
export function mapStreamStatusToAggr(status: string): AggrStatus {
	switch (status) {
		case 'proposed':
		case 'classified':
		case 'decided':
		case 'dispatched':
		case 'working':
		case 'retry':
			return 'running';
		case 'gated':
		case 'held':
			return 'needs-you';
		case 'synthesized':
		case 'done':
		case 'verified':
			return 'done';
		case 'aborted':
			return 'stopped';
		case 'failed':
		case 'error':
			return 'failed';
		default:
			return 'running';
	}
}

/** True once the run is in any terminal aggregate state. */
export function isTerminalAggr(aggr: AggrStatus): boolean {
	return aggr === 'done' || aggr === 'failed' || aggr === 'stopped';
}

/**
 * Derive the six stage dots from the stream rows. Same frontier rules as the
 * server's buildPhases: below-frontier stages are 'done' only with real
 * activity (else 'skipped'); the frontier maps the aggregate state honestly
 * ('active' while running, 'failed'/'needs-you'/'blocked' verbatim, 'skipped'
 * on stop); above-frontier stages are 'pending' in flight, 'skipped' once
 * terminal. Research/Approve have no client action vocabulary, so they read
 * skipped on a Read→Build→Reply run — truthful, not falsely green.
 */
export function deriveStageDots(rows: StreamRow[], aggr: AggrStatus): PillStage[] {
	const seen = new Set<string>();
	let highestIndex = -1;
	for (const row of rows) {
		const stage = inferStageFromAction(row.action);
		if (!stage) continue;
		const idx = PIPELINE_STAGES.indexOf(stage);
		if (idx === -1) continue;
		seen.add(stage);
		if (idx > highestIndex) highestIndex = idx;
	}

	const terminal = isTerminalAggr(aggr);

	const dots = PIPELINE_STAGES.map((stage, index): PillStage => {
		const key = stage.toLowerCase() as PhaseKey;
		if (index < highestIndex) {
			return { key, status: seen.has(stage) ? 'done' : 'skipped' };
		}
		if (index === highestIndex) {
			let status: PhaseStatus;
			if (aggr === 'running') status = 'active';
			else if (aggr === 'failed') status = 'failed';
			else if (aggr === 'needs-you') status = 'needs-you';
			else if (aggr === 'blocked') status = 'blocked';
			else if (aggr === 'stopped') status = 'skipped';
			else status = 'done';
			return { key, status };
		}
		return { key, status: terminal ? 'skipped' : 'pending' };
	});

	// Zero mapped activity yet but in flight → Read is the implicit active stage.
	if (highestIndex === -1 && aggr === 'running') {
		dots[0] = { key: dots[0].key, status: 'active' };
	}

	return dots;
}

/** Worker identity for the pill chip. Prefers the job row's worker id (arrives
 *  with the first reconcile); falls back to trace-id sniffing until then. */
export function pillWorker(workerId: string | null | undefined, traceId: string): PillWorker {
	const fromJob = workerId ? WORKER_TEMPLATES[workerId] : undefined;
	if (fromJob) return { shortCode: fromJob.shortCode, display: fromJob.display };
	const t = traceId.toLowerCase();
	let inferred = 'claude-code';
	if (t.includes('agy') || t.includes('antigravity')) inferred = 'antigravity';
	else if (t.includes('gmi') || t.includes('gemini')) inferred = 'gemini';
	else if (t.includes('cdx') || t.includes('codex')) inferred = 'codex';
	else if (t.includes('dpsk') || t.includes('deepseek')) inferred = 'deepseek';
	const template = WORKER_TEMPLATES[inferred] ?? WORKER_TEMPLATES['claude-code'];
	return { shortCode: template.shortCode, display: template.display };
}

/**
 * Working-state Lottie selection (icon-wiring pass, operator-approved set —
 * static/anim/manifest.json). Pure derivation, truth-guard aware:
 *   - trust !== 'trusted' → no animation at all (an unverified/stale pill must
 *     not wear live motion, same rule as the suppressed dot pulse);
 *   - 'stopped' is neutral-terminal → deliberately animation-free;
 *   - raw stream status picks the moment (planning/dispatched/retry...);
 *   - while 'working', the stage frontier picks active vs verifying;
 *   - done/failed play ONCE and hold (loop=false) — motion stops when work stops.
 */
export interface PillAnim {
	file: string;
	loop: boolean;
}

export function pillAnimFor(opts: {
	status: string;
	aggr: AggrStatus;
	stages: PillStage[];
	trust: PillTrust;
}): PillAnim | null {
	if (opts.trust !== 'trusted') return null;
	switch (opts.status) {
		case 'proposed':
		case 'classified':
		case 'decided':
			return { file: 'state-planning-v4.json', loop: true };
		case 'dispatched':
			return { file: 'worker-dispatched-ping.json', loop: true };
		case 'retry':
			return { file: 'state-retry-elastic.json', loop: true };
		case 'opening_pr':
			return { file: 'state-opening-pr-v4.json', loop: true };
		case 'merged':
			return { file: 'state-merged-v4.json', loop: true };
	}
	switch (opts.aggr) {
		case 'running': {
			const active = opts.stages.find((s) => s.status === 'active');
			const verifying = active?.key === 'check' || active?.key === 'approve';
			return verifying
				? { file: 'worker-verifying-scan.json', loop: true }
				: { file: 'worker-active-orbit.json', loop: true };
		}
		case 'needs-you':
		case 'blocked':
			return { file: 'worker-waiting-breath.json', loop: true };
		case 'done':
			return { file: 'worker-done-check.json', loop: false };
		case 'failed':
			return { file: 'worker-failed-x.json', loop: false };
		default:
			return null; // 'stopped' — neutral, no motion
	}
}

/** Operator-approved brand-reveal Lotties (primary per worker) — played ONCE
 *  as the pill's mount intro for live, trusted runs, then the working-state
 *  animation takes over. Keyed by the pill chip's shortCode. */
export const BRAND_REVEALS: Record<string, string> = {
	CC: 'brand/brand-claude-reveal.json',
	AGY: 'brand/brand-antigravity-reveal.json',
	CDX: 'brand/brand-codex-reveal.json',
	GMI: 'brand/brand-gemini-bloom.json',
	DPSK: 'brand/brand-deepseek-reveal.json',
	CUR: 'brand/brand-cursor-assemble.json'
};

/** Compact mono elapsed: 42s → 3m12s → 1h04m. Tabular-nums friendly. */
export function fmtElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '';
	const totalSecs = Math.floor(ms / 1000);
	if (totalSecs < 60) return `${totalSecs}s`;
	const mins = Math.floor(totalSecs / 60);
	const secs = totalSecs % 60;
	if (mins < 60) return `${mins}m${String(secs).padStart(2, '0')}s`;
	const hours = Math.floor(mins / 60);
	const remMins = mins % 60;
	return `${hours}h${String(remMins).padStart(2, '0')}m`;
}

/** Same UTC-normalizing timestamp parse as the dispatch stream (SQLite
 *  CURRENT_TIMESTAMP is unmarked UTC; toISOString carries 'Z'). */
export function parsePillTs(s: string | null | undefined): number {
	if (!s) return NaN;
	let v = s.trim().replace(' ', 'T');
	if (!/[zZ]|[+-]\d\d:?\d\d$/.test(v)) v += 'Z';
	return Date.parse(v);
}

/** Max-elapsed sanity cap (LOS-196): past this, a non-terminal pill stops
 *  claiming a live elapsed clock and renders the explicit "stale — checking…"
 *  state while forcing reconcile fetches. */
export const PILL_STALE_CAP_MS = 45 * 60 * 1000;

export type PillTrust = 'trusted' | 'unverified' | 'stale';

/**
 * Truth guard (LOS-196): how far the pill may trust a non-terminal status.
 *   - terminal statuses are always trusted — they only arrive as server truth
 *     (reconcile job row or SSE __terminal__ frame);
 *   - a non-terminal status is 'unverified' until the first successful
 *     reconcile against /api/chat/dispatch/[trace] — the stream's "working"
 *     default must not read as a confirmed live run (no fake running on
 *     mount, and no fake running forever when the reconcile fetch fails);
 *   - past the max-elapsed cap it is 'stale' — render "stale — checking…",
 *     never a confidently-live clock (no fake running after done).
 */
export function derivePillTrust(opts: {
	terminal: boolean;
	reconciled: boolean;
	startedAtIso: string | null | undefined;
	nowMs: number;
	capMs?: number;
}): PillTrust {
	if (opts.terminal) return 'trusted';
	if (!opts.reconciled) return 'unverified';
	const start = parsePillTs(opts.startedAtIso);
	const cap = opts.capMs ?? PILL_STALE_CAP_MS;
	if (Number.isFinite(start) && opts.nowMs - start > cap) return 'stale';
	return 'trusted';
}
