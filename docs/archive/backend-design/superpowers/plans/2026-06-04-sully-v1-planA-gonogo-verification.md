# Sully v1 — Plan A: Deterministic Go/No-Go Verification + Claim Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a worker completes, run a deterministic Go/No-Go poll over the evidence it deposited, build a Claim Ledger, and drive Sully's final wording by posture — so she never states an unconfirmed claim as fact. (Proves acceptance test **#5**.)

**Architecture:** A new pure module `verifyPoll.ts` reads a typed **evidence envelope** (pointers the worker deposits in its completion callback) and runs one deterministic check per _active_ channel (a channel votes only if its pointer is present). It returns a per-channel matrix + a Claim Ledger (`GO`/`NO_GO`/`UNKNOWN`, `allowed_in_final == GO`) + a posture (`confirmed`/`hedge`/`warn`). `closeOutTask` runs the poll between `getJob()` and synthesis, stamps `markVerified` + a new `verification_evidence` column, journals the matrix, and passes the posture into `synthesizeWorkerResult`, which selects the framing. **No AI in the verdict.** Strictly additive — does NOT touch the live streaming pipeline.

**Tech Stack:** SvelteKit (server), better-sqlite3, vitest, `node:child_process` (git/gh), `fetch` (health).

**v1 channels:** `worker_completion` + `task_state` (always-on, read existing records) + `git` (SHA) + `pr` (gh) + `artifact` (fs) + `health` (curl). **Deferred to v2:** `test_evidence` (a worker-typed exit code isn't proof) and `database`. **v1 criticality:** `worker_completion`/`task_state`/`git`/`pr`/`artifact` are _critical_ (deliverables); `health` is _non-critical_ (descriptive) — gives both a `warn`+COMPLETE path and a `needs_review` path per the spec.

**Spec:** `docs/superpowers/specs/2026-06-04-sully-task-first-state-machine-v1-design.md` (Contract 3, §3/§5/§9).

---

## File structure

- **Create** `src/lib/server/verifyPoll.ts` — pure poll engine: types, per-channel checks, `posture()`, `runPoll()`.
- **Create** `tests/verify-poll.test.ts` — unit tests over synthetic envelopes (pure, deterministic, no live git needed for the reducer).
- **Create** `tests/verify-acceptance.test.ts` — acceptance test **#5** (UNKNOWN never stated as fact) end-to-end through `closeOutTask`.
- **Modify** `src/lib/server/dispatchJobs.ts` — add `verification_evidence` to `TASK_COLUMNS`; widen `markVerified` to accept the matrix JSON.
- **Modify** `src/lib/server/bootstrap.ts` — add `verification_evidence: 'TEXT'` to `jobMigrations`.
- **Modify** `src/lib/server/chatActivity.ts` — add `'verification_poll'` to `TASK_EVENT_ACTIONS`.
- **Modify** `src/lib/server/completionClose.ts` — run the poll, stamp, journal, pass posture to synthesis.
- **Modify** `src/lib/server/routing/synthesize.ts` — `posture` param → framing.
- **Modify** `src/routes/api/chat/activity/+server.ts` — parse `body.evidence`, pass to `closeOutTask`.
- **Modify** `src/lib/server/companionDispatch.ts` (`buildWorkerPrompt`) — add the evidence-envelope spec (done LAST, after the consumer exists).

---

## Task A0: schema column + widen `markVerified` (backward-compatible, schema-first)

**Files:** Modify `src/lib/server/dispatchJobs.ts`, `src/lib/server/bootstrap.ts`; Test `tests/verify-schema.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/verify-schema.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-verify-schema-test.db';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: DB,
		COMPANION_DISPATCH_ENABLED: 'true'
	}
}));
beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

describe('verification_evidence column + markVerified', () => {
	it('stores the matrix JSON on the job row and flips done→verified', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		const j = await import('$lib/server/dispatchJobs');
		bootstrapCompanionDb();
		j.createJob({
			traceId: 's1',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0
		});
		j.markDispatched('s1');
		j.markDone('s1', 'ok');
		j.markVerified('s1', 'confirmed', null, '{"overall":"GO"}');
		const job = j.getJob('s1')!;
		expect(job.status).toBe('verified');
		expect(job.verification_state).toBe('confirmed');
		expect(job.verification_evidence).toContain('"overall":"GO"');
	});
});
```

- [ ] **Step 2: Run, verify it fails.** `npx vitest run tests/verify-schema.test.ts` → FAIL (`markVerified` takes 3 args / `verification_evidence` undefined).

- [ ] **Step 3: Add the column to `bootstrap.ts` `jobMigrations`** (after `verification_ref: 'TEXT',`):

```ts
			verification_ref: 'TEXT',
			verification_evidence: 'TEXT',
```

- [ ] **Step 4: Add the column to `dispatchJobs.ts` `TASK_COLUMNS`** (after `verification_ref: 'TEXT',`) and to the `PendingJob` interface (after `verification_ref: string | null;`):

```ts
verification_ref: string | null;
verification_evidence: string | null;
```

- [ ] **Step 5: Widen `markVerified`** in `dispatchJobs.ts`:

```ts
export function markVerified(
	traceId: string,
	state: string,
	ref: string | null,
	evidence: string | null = null
): void {
	transition(traceId, 'verified', {
		verification_state: state,
		verification_ref: ref,
		verification_evidence: evidence
	});
}
```

- [ ] **Step 6: Run, verify pass.** `npx vitest run tests/verify-schema.test.ts` → PASS.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(verify): add verification_evidence column + widen markVerified"`

---

## Task A1: the pure poll engine (`verifyPoll.ts`)

**Files:** Create `src/lib/server/verifyPoll.ts`, `tests/verify-poll.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/verify-poll.test.ts` (pure; no env/db mock needed for the reducer + posture; channel checks are injected so they're deterministic):

```ts
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
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run tests/verify-poll.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/server/verifyPoll.ts`** (types + pure reducers; channel checks added in A1b):

```ts
// Deterministic Go/No-Go verification (Phase 4 / Contract 3). NO AI in the verdict.
// A channel votes only if the worker deposited its evidence pointer; absent → SKIPPED.
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
```

- [ ] **Step 4: Run, verify pass.** `npx vitest run tests/verify-poll.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(verify): pure Go/No-Go reducers (posture + ledger)"`

---

## Task A1b: the deterministic channel checks + `runPoll`

**Files:** Modify `src/lib/server/verifyPoll.ts`; Test `tests/verify-channels.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/verify-channels.test.ts` (drives the FSM channels off a job + the pointer channels off a temp dir; gh/curl are not hit — a missing pointer → SKIPPED, a present-but-unresolvable pointer → UNKNOWN, never a crash):

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPoll, type EvidenceEnvelope } from '$lib/server/verifyPoll';

const job = (over: Record<string, unknown> = {}) =>
	({
		trace_id: 's1',
		status: 'done',
		started_at: '2000-01-01 00:00:00',
		...over
	}) as never;

describe('runPoll channels', () => {
	it('done job, no pointers → FSM channels GO (liveness) but posture HEDGE, never confirmed', async () => {
		const r = await runPoll(job(), {});
		const wc = r.channels.find((c) => c.channel === 'worker_completion')!;
		const ts = r.channels.find((c) => c.channel === 'task_state')!;
		expect(wc.state).toBe('GO');
		expect(ts.state).toBe('GO');
		expect(r.channels.find((c) => c.channel === 'git')!.state).toBe('SKIPPED');
		// liveness-only → cannot confirm a deliverable that wasn't checked
		expect(r.posture).toBe('hedge');
	});
	it('a real deliverable GO (an existing artifact) → confirmed', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-'));
		const p = path.join(dir, 'made.txt');
		fs.writeFileSync(p, 'x');
		const r = await runPoll(job(), { fs_paths: [p] });
		expect(r.posture).toBe('confirmed');
	});
	it('failed job → worker_completion NO_GO (critical) → needs_review + warn', async () => {
		const r = await runPoll(job({ status: 'failed' }), {});
		expect(r.channels.find((c) => c.channel === 'worker_completion')!.state).toBe('NO_GO');
		expect(r.posture).toBe('warn');
		expect(r.needs_review).toBe(true);
	});
	it('artifact GO when a declared path exists with post-start mtime', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-'));
		const p = path.join(dir, 'made.txt');
		fs.writeFileSync(p, 'x');
		const env: EvidenceEnvelope = { fs_paths: [p] };
		const r = await runPoll(job(), env);
		expect(r.channels.find((c) => c.channel === 'artifact')!.state).toBe('GO');
	});
	it('artifact NO_GO when a declared path does not exist', async () => {
		const r = await runPoll(job(), { fs_paths: ['/tmp/does-not-exist-xyz.123'] });
		expect(r.channels.find((c) => c.channel === 'artifact')!.state).toBe('NO_GO');
		expect(r.needs_review).toBe(true); // artifact is critical
	});
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run tests/verify-channels.test.ts` → FAIL (`runPoll` not exported).

- [ ] **Step 3: Implement the channels + `runPoll`** — append to `verifyPoll.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
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
```

Add `import path from 'node:path';` at the top.

- [ ] **Step 4: Run, verify pass.** `npx vitest run tests/verify-channels.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(verify): deterministic channel checks + runPoll (git/pr/artifact/health + FSM)"`

---

## Task A2: posture-driven synthesis (`synthesize.ts`)

**Files:** Modify `src/lib/server/routing/synthesize.ts`; Test `tests/verify-synthesis.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/verify-synthesis.test.ts` (the synthesis system prompt must change with posture; we assert the prompt the bridge receives, by mocking `runConsultClaude`):

```ts
import { describe, it, expect, vi } from 'vitest';
const calls: { question: string; system?: string }[] = [];
vi.mock('$lib/server/chat/consult', () => ({
	runConsultClaude: vi.fn(async (q: string, _m: string, system?: string) => {
		calls.push({ question: q, system });
		return { answer: 'ok' };
	})
}));

describe('synthesizeWorkerResult posture framing', () => {
	it('hedge posture instructs the model NOT to state unverified claims as fact', async () => {
		const { synthesizeWorkerResult } = await import('$lib/server/routing/synthesize');
		await synthesizeWorkerResult({ brief: 'b', result: 'r', posture: 'hedge' });
		expect((calls.at(-1)!.system || '').toLowerCase()).toMatch(
			/could ?n.t (independently )?confirm|hedge|not.*as fact/
		);
	});
	it('warn posture instructs a heads-up framing', async () => {
		const { synthesizeWorkerResult } = await import('$lib/server/routing/synthesize');
		await synthesizeWorkerResult({ brief: 'b', result: 'r', posture: 'warn' });
		expect((calls.at(-1)!.system || '').toLowerCase()).toMatch(
			/heads-up|doesn.t line up|contradict/
		);
	});
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run tests/verify-synthesis.test.ts` → FAIL (`posture` not accepted / framing absent).

- [ ] **Step 3: Add `posture` to `synthesizeWorkerResult`** in `synthesize.ts`. Change the args type to include `posture?: 'confirmed' | 'hedge' | 'warn'` and select a framing appended to `SYNTH_SYSTEM`:

```ts
const POSTURE_FRAMING: Record<'confirmed' | 'hedge' | 'warn', string> = {
	confirmed: '',
	hedge:
		'\n\nIMPORTANT: Some of what the worker reported could NOT be independently verified. Do not state those parts as fact — lead with the uncertainty ("I couldn\'t confirm whether X — the worker said it did, but I have no evidence either way"). Never headline an unverified claim. Never say "it works" — only "everything I could check held up."',
	warn: '\n\nIMPORTANT: A deterministic check CONTRADICTS something the worker claimed. Open with a plain "Heads-up — something doesn\'t line up," name what was contradicted in plain English, and do NOT state the contradicted claim as fact. Recommend the Captain review it.'
};

export async function synthesizeWorkerResult(
	args: { brief: string; result: string; posture?: 'confirmed' | 'hedge' | 'warn' },
	timeoutMs = SYNTH_TIMEOUT_MS
): Promise<string | null> {
	const result = (args.result || '').trim();
	if (!result) return null;
	const system = SYNTH_SYSTEM + (POSTURE_FRAMING[args.posture ?? 'confirmed'] || '');
	const question = `Task you handed off: "${(args.brief || '').trim() || '(no brief recorded)'}".\n\nThe worker's raw result:\n\n${result}\n\nWrite the plain-English summary for the Captain now.`;
	const gen = runConsultClaude(question, SYNTH_MODEL, system)
		.then((r) => ('answer' in r && r.answer ? r.answer.trim() : null))
		.catch(() => null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((res) => {
		timer = setTimeout(() => res(null), timeoutMs);
	});
	const out = await Promise.race([gen, timeout]);
	if (timer) clearTimeout(timer);
	return out;
}
```

- [ ] **Step 4: Run, verify pass.** `npx vitest run tests/verify-synthesis.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(verify): posture-driven synthesis framing"`

---

## Task A3: wire the poll into `closeOutTask` + journal

**Files:** Modify `src/lib/server/completionClose.ts`; Test extends `tests/verify-acceptance.test.ts` (Task A5)

- [ ] **Step 1: Edit `closeOutTask`** — between `const job = getJob(traceId);` and the `summary` line, run the poll, stamp, journal, and thread the posture into synthesis. Add the param + imports:

```ts
import { runPoll } from './verifyPoll';
import type { EvidenceEnvelope } from './verifyPoll';
// ...
export async function closeOutTask(
	traceId: string,
	outcome: 'done' | 'failed',
	resultText: string,
	evidence: EvidenceEnvelope = {}
): Promise<void> {
	const job = getJob(traceId);
	if (job?.status === 'synthesized') return;
	if (hasTaskEvent(traceId, 'synthesis_completed')) return;
	const threadId = resolveCompletionThread(job?.thread_id);
	const text = resultText.trim();

	// ── Phase 4: deterministic Go/No-Go poll BEFORE synthesis (only on success). ──
	let pollPosture: 'confirmed' | 'hedge' | 'warn' = 'confirmed';
	if (outcome === 'done' && job) {
		try {
			const poll = await runPoll(job, evidence);
			pollPosture = poll.posture;
			logTaskEvent(traceId, 'verification_poll', {
				overall: poll.posture,
				needs_review: poll.needs_review,
				channels: poll.channels.map((c) => ({
					channel: c.channel,
					state: c.state,
					detail: c.detail
				}))
			});
			try {
				markVerified(
					traceId,
					poll.posture,
					poll.ledger.find((e) => e.critical)?.evidence_pointer ?? null,
					JSON.stringify(poll.channels)
				);
			} catch {
				/* terminal-state race — non-fatal */
			}
		} catch (e) {
			console.warn('[completionClose] poll skipped:', e);
		}
	}

	const summary = text
		? await synthesizeWorkerResult({ brief: job?.brief ?? '', result: text, posture: pollPosture })
		: null;
	// ... (unchanged from here: msg fallback, addChatMessage, markSynthesized, push)
}
```

Add `import { markVerified } from './dispatchJobs';` to the existing `dispatchJobs` import line, and `'verification_poll'` must be a known journal action (Task A4).

- [ ] **Step 2: Typecheck.** `npm run check` → 0 errors. (Behavior asserted by the acceptance test in A5.)
- [ ] **Step 3: Commit.** `git add -A && git commit -m "feat(verify): run Go/No-Go poll in closeOutTask, journal the matrix, drive posture"`

---

## Task A4: journal vocabulary + activity-POST evidence parse

**Files:** Modify `src/lib/server/chatActivity.ts`, `src/routes/api/chat/activity/+server.ts`

- [ ] **Step 1: Add `'verification_poll'`** to `TASK_EVENT_ACTIONS` in `chatActivity.ts` (after `'synthesis_completed'`).
- [ ] **Step 2: Parse `evidence` in the activity POST handler** — widen the `body` type to include `evidence?: import('$lib/server/verifyPoll').EvidenceEnvelope` and pass it through both `closeOutTask` calls:

```ts
await closeOutTask(trace_id, 'done', body.result_ref ?? '', body.evidence ?? {});
```

(The `'failed'` call stays `closeOutTask(trace_id, 'failed', body.target ?? '')` — no poll on failure.)

- [ ] **Step 3: Typecheck.** `npm run check` → 0 errors.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(verify): accept evidence envelope on the worker callback + journal action"`

---

## Task A5: acceptance test #5 — UNKNOWN is never stated as fact (end-to-end)

**Files:** Create `tests/verify-acceptance.test.ts`

- [ ] **Step 1: Write the acceptance test** (a worker claims "tests passed" but deposits NO test pointer and NO checkable evidence → posture must be `hedge`, and the synthesis prompt must carry the do-not-state-as-fact instruction; a contradicted artifact → `warn` + needs_review):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-verify-accept-test.db';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: DB,
		COMPANION_DISPATCH_ENABLED: 'true'
	}
}));
const synth = vi.fn(async () => 'summary');
vi.mock('$lib/server/routing/synthesize', () => ({ synthesizeWorkerResult: synth }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
	synth.mockClear();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

async function seedDone(traceId: string, evidence: object) {
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	const j = await import('$lib/server/dispatchJobs');
	bootstrapCompanionDb();
	j.createJob({
		traceId,
		worker: 'claude-code',
		category: 'code',
		brief: 'run the tests',
		fingerprint: 'f',
		predictedTokens: 0,
		threadId: 't1'
	});
	j.markDispatched(traceId);
	j.markDone(traceId, 'All tests passed');
	return { evidence };
}

describe('acceptance #5 — UNKNOWN is never stated as fact', () => {
	it('a "tests passed" claim with no checkable evidence → hedge posture into synthesis', async () => {
		await seedDone('s-unk', {});
		const { closeOutTask } = await import('$lib/server/completionClose');
		await closeOutTask('s-unk', 'done', 'All tests passed', {}); // no evidence pointers
		// FSM channels are GO (liveness) but nothing deliverable is checkable → hedge
		expect(synth).toHaveBeenCalledWith(expect.objectContaining({ posture: 'hedge' }));
		const j = await import('$lib/server/dispatchJobs');
		expect(j.getJob('s-unk')!.verification_state).toBe('hedge');
	});

	it('a contradicted artifact claim → warn posture + needs_review journaled', async () => {
		await seedDone('s-no', {});
		const { closeOutTask } = await import('$lib/server/completionClose');
		await closeOutTask('s-no', 'done', 'Wrote the file', {
			fs_paths: ['/tmp/definitely-not-here.xyz']
		});
		expect(synth).toHaveBeenCalledWith(expect.objectContaining({ posture: 'warn' }));
		const { getActivityForTrace } = await import('$lib/server/chatActivity');
		const poll = getActivityForTrace('s-no', 50).find((a) => a.action === 'verification_poll');
		expect(poll && JSON.parse(poll.target!).needs_review).toBe(true);
	});
});
```

> Why `hedge` (not `confirmed`) here: the **liveness rule** (Task A1). "Tests passed" with no checkable evidence leaves only the FSM channels GO — and FSM channels are `liveness: true`, so they prove the worker _finished_, not that the claim is _true_. With no deliverable (non-liveness) channel proven, `posture()` returns `hedge`. No prose keyword-scanning needed; the liveness rule handles it deterministically.

- [ ] **Step 2: Run.** `npx vitest run tests/verify-acceptance.test.ts` → PASS.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "test(verify): acceptance #5 — UNKNOWN never stated as fact"`

---

## Task A6: worker-prompt evidence-envelope spec (LAST — consumer exists first)

**Files:** Modify `src/lib/server/companionDispatch.ts` (`buildWorkerPrompt`)

- [ ] **Step 1: Extend the CLOSING contract** in `buildWorkerPrompt` to ask the worker to deposit pointer telemetry (only what applies):

```ts
CLOSING — POST a terminal row, then your result-marker telemetry AND an evidence envelope of POINTERS (include only what you actually did; omit the rest — a missing pointer just means Sully can't independently confirm that part):
  { "trace_id": "${input.traceId}", "action": "completed", "result_ref": "<final message or artifact ref>",
    "evidence": { "fs_paths": ["<files you created/edited>"], "git_ref": "<commit SHA>", "repo": "${input.targetRepo}", "pr_number": <PR number or null>, "health_url": "<service URL you can claim is up, or null>" },
    "marker": { "worker": "claude-code", "model": "<model>", "usage": { "prompt": 0, "completion": 0, "cache_read": 0, "cache_creation": 0, "total": 0 } } }
On failure POST action "failed" with target set to a one-line reason.`;
```

- [ ] **Step 2: Typecheck + full suite.** `npm run check && npx vitest run` → 0 errors, all green.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "feat(verify): worker deposits a pointer evidence envelope on completion"`

---

## Final review (after all tasks)

- [ ] Full suite green; `npm run check` 0 errors.
- [ ] Adversarial review of the diff (focus: any path where verification can throw and lose a result (I7); any GO that isn't deterministic; the unbacked-strong-claim rule).
- [ ] Browser/live QA: dispatch a real `@cc` task that returns evidence; confirm the journal has a `verification_poll` matrix and Sully's wording matches the posture.
- [ ] Update `docs/SESSION-HANDOFF.md`; operator live-QA + merge.

---

## How the 8 acceptance tests map across v1 (decomposition)

| #   | Acceptance behavior                                                                   | Plan                                                                                      |
| --- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 5   | UNKNOWN claims not stated as facts                                                    | **A (this plan)**                                                                         |
| 6   | Adversary findings labeled as concerns, not facts                                     | **B** — adversary review (stakes-gated), builds on A's matrix                             |
| 7   | Running task doesn't block conversation                                               | **C** — task mutation rule (largely already true; C adds tests + the mutation gate)       |
| 8   | Mid-task changes queued / attached pre-dispatch / sibling — never injected or dropped | **C**                                                                                     |
| 1   | Brainstorming doesn't auto-dispatch                                                   | **D** — turn spine (intent gate)                                                          |
| 2   | Explicit work intent creates a task                                                   | **D**                                                                                     |
| 3   | Voice/talkback + text use the same pipeline                                           | **D**                                                                                     |
| 4   | Worker-dependent turns don't stream a full answer before classification               | **D** — the classify-before-answer reorder (riskiest; touches live streaming → done last) |

**Build order (low-risk-first):** A (verification, self-contained, no live-pipeline risk) → B (adversary, builds on A) → C (active-task handling) → D (the streaming reorder, most care). Tests #1, #2, #7 can also be written early against current behavior to prove they already hold.
