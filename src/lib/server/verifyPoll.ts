// Deterministic Go/No-Go verification (Phase 4 / Contract 3). NO AI in the verdict.
// A channel votes only if the worker deposited its evidence pointer; absent → SKIPPED.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

export interface EvidenceEnvelope {
	fs_paths?: string[] | null;
	git_ref?: string | null; // SHA or branch
	repo?: string | null; // target repo name, e.g. 'LogueOS-Companion'
	pr_number?: number | null;
	health_url?: string | null;
	// v2 (deferred): test_exit_code, test_summary_path, db_check
}

export interface ChannelResult {
	channel: string;
	state: 'GO' | 'NO_GO' | 'UNKNOWN' | 'SKIPPED';
	critical: boolean;
	liveness?: boolean; // true = proves the worker RAN, not that a deliverable is true (FSM channels)
	detail: string;
	evidence_pointer: string | null;
}

export interface ClaimLedgerEntry {
	claim: string;
	source: string;
	verification_status: 'GO' | 'NO_GO' | 'UNKNOWN';
	evidence_pointer: string | null;
	critical: boolean;
	allowed_in_final: boolean;
	needs_review: boolean;
}

export type Posture = 'confirmed' | 'hedge' | 'warn';

/** Posture (drives wording). any NO_GO → warn; else any active UNKNOWN → hedge; else confirmed.
 *  SKIPPED channels are ignored. An all-SKIPPED/UNKNOWN set is hedge, never confirmed. */
export function posture(results: ChannelResult[]): Posture {
	const active = results.filter((r) => r.state !== 'SKIPPED');
	// A NO_GO anywhere (incl. a liveness failure = worker crashed) → warn.
	if (active.some((r) => r.state === 'NO_GO')) return 'warn';
	// Liveness channels prove the worker RAN, not that any deliverable claim is
	// true — so they can never, alone, earn 'confirmed'. Only deliverable
	// (non-liveness) channels can. "Worker finished, nothing else checkable" → hedge.
	const deliverable = active.filter((r) => !r.liveness);
	if (deliverable.some((r) => r.state === 'UNKNOWN')) return 'hedge';
	if (deliverable.length > 0 && deliverable.every((r) => r.state === 'GO')) return 'confirmed';
	return 'hedge'; // no deliverable evidence proven → cannot confirm
}

/** One ledger entry per non-SKIPPED channel. allowed_in_final == GO (I8). */
export function buildLedger(results: ChannelResult[], source = 'worker'): ClaimLedgerEntry[] {
	return results
		.filter((r) => r.state !== 'SKIPPED')
		.map((r) => ({
			claim: r.detail || r.channel,
			source,
			verification_status: r.state as 'GO' | 'NO_GO' | 'UNKNOWN',
			evidence_pointer: r.evidence_pointer,
			critical: r.critical,
			allowed_in_final: r.state === 'GO',
			needs_review: r.state === 'NO_GO' && r.critical
		}));
}

const exec = promisify(execFile);

/** SQLite CURRENT_TIMESTAMP is unmarked UTC; normalize to epoch ms. */
function startedMs(iso: string | null): number {
	if (!iso) return 0;
	let v = iso.trim().replace(' ', 'T');
	if (!/[zZ]|[+-]\d\d:?\d\d$/.test(v)) v += 'Z';
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : 0;
}

type JobLike = { trace_id: string; status: string; started_at: string | null };

const PER_CHANNEL_TIMEOUT_MS = 5000;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
// Allow-list of repo roots Sully may verify against (frame-binding; never worker-arbitrary).
const REPO_ROOTS: Record<string, string> = {
	'LogueOS-Companion': '/home/dreighto/dev/LogueOS-Companion',
	'LogueOS-Orchestrator': '/home/dreighto/dev/LogueOS-Orchestrator',
	'LogueOS-Console': '/home/dreighto/dev/LogueOS-Console',
	miru: '/home/dreighto/dev/miru'
};

/** Run all v1 channels. Every check resolves to GO/NO_GO/UNKNOWN/SKIPPED — it can never throw (I7). */
export async function runPoll(
	job: JobLike,
	env: EvidenceEnvelope
): Promise<{
	channels: ChannelResult[];
	ledger: ClaimLedgerEntry[];
	posture: Posture;
	needs_review: boolean;
}> {
	const startMs = startedMs(job.started_at);
	const repoRoot = env.repo ? REPO_ROOTS[env.repo] : undefined;
	const results: ChannelResult[] = [];

	// 1. worker_completion (always on, critical, LIVENESS — proves it ran, not that a claim is true)
	results.push({
		channel: 'worker_completion',
		critical: true,
		liveness: true,
		evidence_pointer: job.status,
		state: job.status === 'failed' || job.status === 'aborted' ? 'NO_GO' : 'GO',
		detail: `worker status=${job.status}`
	});
	// 2. task_state (always on, critical, LIVENESS)
	results.push({
		channel: 'task_state',
		critical: true,
		liveness: true,
		evidence_pointer: job.status,
		state: ['done', 'verified', 'synthesized'].includes(job.status)
			? 'GO'
			: job.status === 'failed' || job.status === 'aborted'
				? 'NO_GO'
				: 'UNKNOWN',
		detail: `task status=${job.status}`
	});
	// 3. artifact (fs_paths; critical) — exists + under repo root (if known) + mtime > start
	results.push(
		await safe('artifact', true, env.fs_paths, async () => {
			const paths = env.fs_paths!;
			for (const p of paths) {
				if (repoRoot && !path.resolve(p).startsWith(path.resolve(repoRoot))) {
					return no('artifact', true, p, `path escapes repo root`);
				}
				if (!fs.existsSync(p)) return no('artifact', true, p, `missing: ${p}`);
				if (startMs && fs.statSync(p).mtimeMs < startMs)
					return no('artifact', true, p, `stale: ${p}`);
			}
			return go('artifact', true, paths.join(','), `${paths.length} path(s) exist`);
		})
	);
	// 4. git (SHA; critical)
	results.push(
		await safe('git', true, env.git_ref, async () => {
			if (!repoRoot) return unk('git', true, env.git_ref!, 'unknown repo');
			if (!SHA_RE.test(env.git_ref!)) return unk('git', true, env.git_ref!, 'not a SHA');
			try {
				await exec('git', ['-C', repoRoot, 'cat-file', '-e', env.git_ref!], {
					timeout: PER_CHANNEL_TIMEOUT_MS
				});
				return go('git', true, env.git_ref!, 'commit exists');
			} catch {
				return no('git', true, env.git_ref!, 'commit not found in repo');
			}
		})
	);
	// 5. pr (gh; critical)
	results.push(
		await safe('pr', true, env.pr_number, async () => {
			if (!env.repo) return unk('pr', true, String(env.pr_number), 'unknown repo');
			try {
				const { stdout } = await exec(
					'gh',
					[
						'pr',
						'view',
						String(env.pr_number),
						'--repo',
						`Dreighto/${env.repo}`,
						'--json',
						'state'
					],
					{ timeout: PER_CHANNEL_TIMEOUT_MS }
				);
				const state = (JSON.parse(stdout).state as string) || '';
				return state
					? go('pr', true, `#${env.pr_number}`, `PR ${state}`)
					: no('pr', true, `#${env.pr_number}`, 'PR not found');
			} catch {
				return unk('pr', true, `#${env.pr_number}`, 'gh unavailable');
			}
		})
	);
	// 6. health (curl; NON-critical — descriptive)
	results.push(
		await safe('health', false, env.health_url, async () => {
			try {
				const r = await fetch(env.health_url!, {
					signal: AbortSignal.timeout(PER_CHANNEL_TIMEOUT_MS)
				});
				return r.ok
					? go('health', false, env.health_url!, `HTTP ${r.status}`)
					: no('health', false, env.health_url!, `HTTP ${r.status}`);
			} catch {
				return no('health', false, env.health_url!, 'unreachable');
			}
		})
	);

	const ledger = buildLedger(results, 'worker');
	return {
		channels: results,
		ledger,
		posture: posture(results),
		needs_review: ledger.some((e) => e.needs_review)
	};
}

// helpers — a present-but-unresolvable pointer never throws (I7)
function go(c: string, crit: boolean, ptr: string, d: string): ChannelResult {
	return { channel: c, critical: crit, state: 'GO', evidence_pointer: ptr, detail: d };
}
function no(c: string, crit: boolean, ptr: string, d: string): ChannelResult {
	return { channel: c, critical: crit, state: 'NO_GO', evidence_pointer: ptr, detail: d };
}
function unk(c: string, crit: boolean, ptr: string, d: string): ChannelResult {
	return { channel: c, critical: crit, state: 'UNKNOWN', evidence_pointer: ptr, detail: d };
}
async function safe(
	c: string,
	crit: boolean,
	present: unknown,
	run: () => Promise<ChannelResult>
): Promise<ChannelResult> {
	const has = Array.isArray(present)
		? present.length > 0
		: present !== null && present !== undefined;
	if (!has)
		return {
			channel: c,
			critical: crit,
			state: 'SKIPPED',
			evidence_pointer: null,
			detail: 'no evidence'
		};
	try {
		return await run();
	} catch (e) {
		return unk(c, crit, String(present), `check error: ${(e as Error).message}`);
	}
}
