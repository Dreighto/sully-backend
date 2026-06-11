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
import { resolveWorkerTemplate, inferStageFromAction } from '$lib/work-surface/chatBridge.svelte';

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

/** Trace-id sniff — the pre-reconcile HINT only (LOS-205): used while the job
 *  row hasn't arrived yet, never to second-guess a real worker id. Tokenized
 *  (not substring) so short ids like 'ki' can't match inside unrelated trace
 *  words. Defaults to CC as the hint of last resort. */
function sniffWorkerFromTrace(traceId: string): string {
	const tokens = new Set(traceId.toLowerCase().split(/[^a-z0-9]+/));
	const hints = [
		'agy',
		'antigravity',
		'gmi',
		'gemini',
		'cdx',
		'codex',
		'dpsk',
		'deepseek',
		'glm',
		'ki'
	];
	for (const hint of hints) if (tokens.has(hint)) return hint;
	return 'claude-code';
}

/** Worker identity for the pill chip. The job row's worker id (arrives with
 *  the first reconcile) is resolved through the canonical alias map — an
 *  unknown id renders itself, NEVER silently CC (LOS-205 truth guard).
 *  Trace-id sniffing fills in only until the job row arrives. */
export function pillWorker(workerId: string | null | undefined, traceId: string): PillWorker {
	const id = workerId?.trim() ? workerId : sniffWorkerFromTrace(traceId);
	const template = resolveWorkerTemplate(id);
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

// ── Run-sheet selectors (LOS-193, part 2) ───────────────────────────────────
// Pure derivations from the SAME deny-list-filtered stream rows the pill
// consumes — no new verification plumbing. Each selector returns empty when
// the stream carries no matching rows, and the sheet renders nothing for an
// empty selector (truth guard: absent data = absent row).

/** Client mirror of the server humanizer's JSON-vs-text target split
 *  (surfaceAdapter.parseMaybeJson). A structured payload is never shown raw. */
function parseSheetTarget(target: string | null): {
	json: Record<string, unknown> | null;
	text: string | null;
} {
	if (!target) return { json: null, text: null };
	const t = target.trim();
	if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
		try {
			return { json: JSON.parse(t) as Record<string, unknown>, text: null };
		} catch {
			/* not valid JSON — treat as plain text below */
		}
	}
	return { json: null, text: target };
}

function truncateSheetText(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1).trimEnd() + '…';
}

export interface GateBadge {
	kind: 'verify' | 'adversary';
	verdict: 'go' | 'warn' | 'no-go' | 'ran';
	label: string;
}

/**
 * Gate badges from the only gate vocabulary the stream actually delivers:
 * verification_poll (overall GO / NO_GO / warn-ish) and adversary_reviewed
 * (finding count). Rows arrive seq-ascending, so the LATEST result of each
 * kind wins. No matching rows → empty array → the sheet renders no gate row.
 */
export function deriveGateBadges(rows: StreamRow[]): GateBadge[] {
	let verify: GateBadge | null = null;
	let adversary: GateBadge | null = null;
	for (const row of rows) {
		const action = row.action.toLowerCase().trim();
		if (action === 'verification_poll') {
			const { json } = parseSheetTarget(row.target);
			const overall = typeof json?.overall === 'string' ? json.overall : null;
			if (overall === 'GO') {
				verify = { kind: 'verify', verdict: 'go', label: 'Verified — looks good' };
			} else if (overall === 'NO_GO') {
				verify = { kind: 'verify', verdict: 'no-go', label: 'Verified — flagged issues' };
			} else if (overall) {
				verify = { kind: 'verify', verdict: 'warn', label: 'Verified — closer look' };
			} else {
				verify = { kind: 'verify', verdict: 'ran', label: 'Verifying the work' };
			}
		} else if (action === 'adversary_reviewed') {
			const { json } = parseSheetTarget(row.target);
			const count = typeof json?.count === 'number' ? json.count : null;
			if (count === null) {
				adversary = { kind: 'adversary', verdict: 'ran', label: 'Adversarial review' };
			} else if (count === 0) {
				adversary = { kind: 'adversary', verdict: 'go', label: 'Adversary — no issues' };
			} else {
				adversary = {
					kind: 'adversary',
					verdict: 'warn',
					label: `Adversary — ${count} finding${count === 1 ? '' : 's'}`
				};
			}
		}
	}
	return [verify, adversary].filter((b): b is GateBadge => b !== null);
}

/** Actions whose target names a file the worker actually produced/changed. */
const RESULT_FILE_ACTIONS = new Set(['edited', 'wrote_file', 'write_file', 'created_artifact']);

/**
 * Result files = unique plain-text targets of write-shaped actions, in first-
 * seen order. Structured (JSON) targets are never treated as paths. Empty when
 * the worker wrote nothing → the sheet renders no files row at all (operator-
 * locked truth guard: result-files row only when files exist).
 */
export function deriveResultFiles(rows: StreamRow[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const row of rows) {
		const action = row.action.toLowerCase().trim();
		if (!RESULT_FILE_ACTIONS.has(action) && !action.startsWith('write_')) continue;
		const { text } = parseSheetTarget(row.target);
		const path = (text ?? '').trim();
		if (!path || seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

export interface SheetLogEntry {
	seq: number;
	action: string;
	text: string;
}

/**
 * Plain-English log line for one stream row — client mirror of the server's
 * humanizeActivity vocabulary (surfaceAdapter), covering the deny-list-
 * filtered actions the stream actually delivers. A non-coder never sees a raw
 * verb, raw snake_case, or a raw JSON payload: unknown actions Title-Case.
 */
export function sheetLogText(action: string, target: string | null): string {
	const a = action.toLowerCase().trim();
	const { json, text } = parseSheetTarget(target);
	switch (a) {
		case 'thinking':
			return text ? `Thinking — ${truncateSheetText(text, 140)}` : 'Thinking it through';
		case 'reading':
		case 'read':
			return text ? `Reading ${truncateSheetText(text, 140)}` : 'Reading files';
		case 'edited':
			return text ? `Edited ${truncateSheetText(text, 140)}` : 'Edited a file';
		case 'wrote_file':
		case 'write_file':
			return text ? `Wrote ${truncateSheetText(text, 140)}` : 'Wrote a file';
		case 'ran':
		case 'shell':
			return text ? `Ran: ${truncateSheetText(text, 120)}` : 'Running a command';
		case 'running':
		case 'testing':
			return text ? `Running: ${truncateSheetText(text, 120)}` : 'Running a command';
		case 'searching':
			return 'Searching…';
		case 'fetching':
			return 'Looking something up…';
		case 'building':
			return 'Building…';
		case 'finalizing':
			return 'Wrapping up';
		case 'verification_poll': {
			const overall = typeof json?.overall === 'string' ? json.overall : null;
			if (overall === 'GO') return 'Verified — looks good';
			if (overall === 'NO_GO') return 'Verified — flagged issues';
			if (overall) return 'Verified — wants a closer look';
			return 'Verifying the work';
		}
		case 'adversary_reviewed': {
			const count = typeof json?.count === 'number' ? json.count : null;
			if (count === null) return 'Adversarial review';
			return count === 0
				? 'Adversarial review — no issues'
				: `Adversarial review — ${count} finding${count === 1 ? '' : 's'}`;
		}
		case 'created_artifact':
			return text ? `Created artifact ${truncateSheetText(text, 140)}` : 'Created an artifact';
		case 'complete':
		case 'completed':
			return 'Done';
		default:
			// Unknown worker verb: readable Title Case, never raw snake_case.
			return action
				.replace(/_/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
				.replace(/\b\w/g, (c) => c.toUpperCase());
	}
}

/** Humanized chronological log — exactly what the stream provides (the rows
 *  are already deny-list filtered server-side; no timestamps arrive, so none
 *  are invented — seq is the only honest ordinal). */
export function buildSheetLog(rows: StreamRow[]): SheetLogEntry[] {
	return rows.map((row) => ({
		seq: row.seq,
		action: row.action,
		text: sheetLogText(row.action, row.target)
	}));
}

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
