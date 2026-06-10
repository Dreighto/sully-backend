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
