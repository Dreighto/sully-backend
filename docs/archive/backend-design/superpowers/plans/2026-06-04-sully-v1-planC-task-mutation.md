# Sully v1 — Plan C: Task Mutation (active-task conversation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** When the operator keeps talking while a task runs, Sully decides whether the new turn is **conversational-only**, **attach to the current task**, **create a sibling task**, or **save/defer until the current task finishes** — and **never silently injects into, nor silently drops, running work.** (Proves acceptance #7 + #8; spec Contract 2.)

**Architecture (incremental, operator-approved):** **Refactor 1 — substrate (behavior-neutral):** add a per-thread active-task primitive + FSM state-sets; extract the shared turn-lifecycle preamble so text + voice share one chokepoint; bring the legacy route into the task lifecycle. **Refactor 2 — the Mutation Gate (Plan C behavior):** a pure gate at the shared chokepoint; proposal-type discrimination + routing-ask answer; queue-after-complete deferral; the atomic-read race fix; a hard dispatch-API rejection of post-dispatch mutation. **Plan D (classify-before-answer reorder) stays separate.**

**Tech Stack:** SvelteKit server, better-sqlite3, vitest.

**Source:** audit + recommendation `data/peer_reviews/2026-06-04_planC-scope-and-refactor-audit.md`; spec `docs/superpowers/specs/2026-06-04-sully-task-first-state-machine-v1-design.md` (Contract 2).

---

# REFACTOR 1 — substrate (behavior-neutral; ship + QA before Refactor 2)

## Task R1.0: per-thread active-task primitive + FSM state-sets

**Files:** Modify `src/lib/server/dispatchJobs.ts`; Test `tests/active-task.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/active-task.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
const DB = '/tmp/sully-active-task-test.db';
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

describe('getActiveTaskForThread + state sets', () => {
	it('returns the most recent non-terminal task on the thread, null when none/terminal', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		expect(j.getActiveTaskForThread('t1')).toBeNull();
		j.createJob({
			traceId: 'a1',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0,
			threadId: 't1'
		});
		j.markDispatched('a1');
		expect(j.getActiveTaskForThread('t1')?.trace_id).toBe('a1'); // 'dispatched' is active
		expect(j.getActiveTaskForThread('t2')).toBeNull(); // other thread unaffected
		j.markDone('a1', 'r');
		j.markSynthesized('a1', 1);
		expect(j.getActiveTaskForThread('t1')).toBeNull(); // synthesized = terminal
	});
	it('PRE_DISPATCH_STATES / RUNNING_STATES partition the active states', async () => {
		const { PRE_DISPATCH_STATES, RUNNING_STATES } = await import('$lib/server/dispatchJobs');
		for (const s of ['proposed', 'classified', 'gated', 'held'])
			expect(PRE_DISPATCH_STATES.has(s as never)).toBe(true);
		for (const s of ['decided', 'dispatched', 'working', 'retry'])
			expect(RUNNING_STATES.has(s as never)).toBe(true);
		// disjoint
		for (const s of PRE_DISPATCH_STATES) expect(RUNNING_STATES.has(s)).toBe(false);
	});
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run tests/active-task.test.ts` → FAIL.

- [ ] **Step 3: Implement** in `dispatchJobs.ts` — co-locate the sets with `TRANSITIONS`, add the query. The terminal set is the canonical sink states:

```ts
export const PRE_DISPATCH_STATES: ReadonlySet<JobStatus> = new Set([
	'proposed',
	'classified',
	'gated',
	'held'
]);
export const RUNNING_STATES: ReadonlySet<JobStatus> = new Set([
	'decided',
	'dispatched',
	'working',
	'retry'
]);
const TERMINAL_STATES: ReadonlySet<JobStatus> = new Set([
	'done',
	'verified',
	'synthesized',
	'failed',
	'aborted'
]);

/** The single most-recent NON-terminal task on a thread, or null. The primitive
 *  the Mutation Gate reads to answer "is a task active on this thread + what
 *  state?". Covered by idx_pending_jobs_thread — no schema change. */
export function getActiveTaskForThread(threadId: string): PendingJob | null {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return null;
	const db = getDb();
	try {
		const terminal = [...TERMINAL_STATES].map(() => '?').join(',');
		const row = db
			.prepare(
				`SELECT * FROM pending_jobs WHERE thread_id = ? AND status NOT IN (${terminal}) ORDER BY id DESC LIMIT 1`
			)
			.get(threadId, ...TERMINAL_STATES) as PendingJob | undefined;
		return row ?? null;
	} finally {
		db.close();
	}
}
```

- [ ] **Step 4: Run, verify pass.** `npx vitest run tests/active-task.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git add src/lib/server/dispatchJobs.ts tests/active-task.test.ts && git commit -m "feat(planC): getActiveTaskForThread + PRE_DISPATCH/RUNNING state sets"`

## Task R1.1: extract the shared turn-lifecycle preamble (one chokepoint)

**Files:** Modify `src/lib/server/chat/stream_prepare.ts` (or `chat_turn.ts`), `src/routes/api/chat/voice-reply/+server.ts`; Test `tests/turn-lifecycle.test.ts`

> The gate (R2) must run in ONE place that both text + voice flow through. Today `prepareStream` (text) and `voice-reply` (voice) duplicate the preamble (`mintTaskId` → `persistUserTurn` → `classifyAndTouchThread` → `detectTargetRepo`). Extract that into a shared `prepareTurnLifecycle()`; `prepareStream` calls it then builds the TEXT prompt; `voice-reply` calls it then builds the VOICE prompt. **Behavior-neutral** — same calls, same order, same results; only the duplication is removed. (The gate hooks into `prepareTurnLifecycle` in R2.)

- [ ] **Step 1: Write the test** — `tests/turn-lifecycle.test.ts`: assert `prepareTurnLifecycle({text, threadId, sender, source})` returns `{ taskId, currentTier, threadState, targetRepo, userMessageText }` and persists the operator turn + mints a `proposed` task row (mock `$env`, bootstrap DB). (Pins the contract so the voice/text refactors can't drift.)

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
const DB = '/tmp/sully-turn-lifecycle-test.db';
vi.mock('$env/dynamic/private', () => ({
	env: { LOGUEOS_APP_MODE: 'companion', LOGUEOS_MEMORY_DB_PATH: DB }
}));
beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

describe('prepareTurnLifecycle', () => {
	it('mints a task, persists the turn, classifies, resolves the repo', async () => {
		const { prepareTurnLifecycle } = await import('$lib/server/chat/stream_prepare');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const r = await prepareTurnLifecycle({
			text: 'audit the companion repo',
			threadId: 'tL',
			sender: 'operator',
			source: 'voice'
		});
		expect(r.taskId).toMatch(/^sully-/);
		expect(typeof r.currentTier).toBe('string');
		expect(r.userMessageText).toContain('audit the companion');
		const j = await import('$lib/server/dispatchJobs');
		expect(j.getJobsForThread('tL').length).toBeGreaterThan(0); // a task row exists
	});
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run tests/turn-lifecycle.test.ts` → FAIL.
- [ ] **Step 3: Extract `prepareTurnLifecycle`** from `prepareStream`'s preamble (the `mintTaskId`/`persistUserTurn`/`classifyAndTouchThread`/`detectTargetRepo` block, currently ~lines 113-120) into an exported function; `prepareStream` calls it and keeps building the text prompt from its result. Match the existing field names exactly (`taskId`, `currentTier`, `threadState`, `targetRepo`, `userMessageText`).
- [ ] **Step 4: Migrate `voice-reply/+server.ts`** to call `prepareTurnLifecycle({...source:'voice'})` instead of its inline `mintTaskId`/`persistUserTurn`/`classifyAndTouchThread`/`detectTargetRepo` (lines ~50-56). Keep `buildVoiceSystemPrompt` + the Ollama message-list build unchanged.
- [ ] **Step 5: Run + verify.** `npx vitest run` (full) + `npm run check` → all green, 0 errors. The voice + text flows must be behavior-identical (no test should change behavior; only the new lifecycle test is added).
- [ ] **Step 6: Commit.** `git add src/lib/server/chat/stream_prepare.ts src/routes/api/chat/voice-reply/+server.ts tests/turn-lifecycle.test.ts && git commit -m "refactor(planC): extract shared prepareTurnLifecycle; voice + text share one chokepoint (behavior-neutral)"`

## Task R1.2: bring the legacy `/api/chat` route into the task lifecycle

**Files:** Modify `src/routes/api/chat/+server.ts`

> Today the legacy handler calls `persistUserTurn` WITHOUT a `taskId` (so `proposeTask` is skipped — no task row minted), and `mintTaskId()` (line ~209) is only a gateway trace id. `getActiveTaskForThread` would under-report running work for any thread that took a turn through this route. Fix: mint ONE turn `taskId` up front, pass it to `persistUserTurn` + `classifyAndTouchThread`, and reuse it for the gateway trace. **Behavior-neutral** (a self-handled `proposed` row that never advances is already the Phase-1 norm). Do NOT touch the `shouldDispatch`/`shouldRouteChat`/Hermes/imageMode routing block — the full legacy migration is a separate later refactor.

- [ ] **Step 1:** Mint `const turnTaskId = mintTaskId();` near the top of the POST handler; pass `taskId: turnTaskId` into `persistUserTurn` (line ~103) and `classifyAndTouchThread` (line ~109). Reuse `turnTaskId` as the gateway dispatch `traceId` (replacing the standalone `mintTaskId()` at ~209).
- [ ] **Step 2:** `npm run check` (0 errors) + `npx vitest run` (green) — confirm no existing `/api/chat` test regresses.
- [ ] **Step 3: Commit.** `git add src/routes/api/chat/+server.ts && git commit -m "refactor(planC): legacy /api/chat mints a turn task row (lifecycle parity; behavior-neutral)"`

## R1 final

- [ ] Full suite + `npm run check` green. Adversarial review of the diff (focus: behavior-neutrality — does any text/voice/legacy flow change? the preamble extraction preserves order + results?). PR → operator QA + merge. **R1 ships zero behavior change.**

---

# REFACTOR 2 — the Mutation Gate (Plan C behavior; build after R1 merges)

> Detailed TDD steps authored when R1 lands (so they target the merged substrate). Scope, from the approved audit recommendation:

- **R2.0 — `src/lib/server/routing/mutation_gate.ts` (pure, unit-tested):** `runMutationGate(threadId, userText)` → `{ classification: 'CONVERSATIONAL_ONLY' | 'ATTACH_TO_CURRENT_TASK' | 'CREATE_SIBLING_TASK' | 'DEFER_UNTIL_DONE' | 'NO_ACTIVE_TASK' | 'AMBIGUOUS', activeTaskId, activeTaskStatus, attachLegal }`. `attachLegal = PRE_DISPATCH_STATES.has(status)`; a running task with attach-intent → `DEFER_UNTIL_DONE` or `CREATE_SIBLING_TASK`, never ATTACH. Bias safe: prefer AMBIGUOUS (→ routing-ask) over a wrong ATTACH; prefer SIBLING over injecting.
- **R2.1 — gate as a required step in `prepareTurnLifecycle`:** run it, add `mutationGate: MutationGateResult` as a **non-optional** field on the lifecycle result + `PreparedStreamContext` (compile-enforced — the gate can't be skipped). Runs before the persist point-of-no-return / before any LLM call.
- **R2.2 — proposal-type discrimination + routing-ask answer:** stamp `proposal_type: 'dispatch' | 'routing_ask'` into the `result_ref` JSON (no migration); `getPendingProposal`/`getProposalByTaskId` expose it; missing → treat as `'dispatch'` (legacy). Add `isRoutingAnswer(text): 'current' | 'new' | null` to `routing/confirm.ts`. `maybeAutonomousDispatch` routes a `routing_ask` answer accordingly.
- **R2.3 — honor the gate in `maybeAutonomousDispatch` + both route handlers:** `CONVERSATIONAL_ONLY` → as today; running-`ATTACH` → write a deferral, return a `held: queued-after-complete` result (surfaced via `spokenSuffix` / data-stream annotation), never inject; `CREATE_SIBLING` → mint a NEW task_id.
- **R2.4 — queue-after-complete deferral + atomic read:** store the held ATTACH (additive `deferred_payload` column via the existing migration pattern, or a small `deferred_turns` table) inside a `BEGIN IMMEDIATE` transaction wrapping read+classify+write (closes the double-ATTACH race); terminal handlers (`markDone`/`markSynthesized`/`markFailed`) re-surface the deferral via an internal pipeline call (NOT an HTTP re-POST). v1-simplest: decline-and-store + "added to your queue — I'll ask again when this finishes."
- **R2.5 — AGY's hard backstop:** `dispatchToWorker` rejects any payload update for a `trace_id` already past the `dispatched` boundary (belt-and-suspenders vs mid-flight mutation).
- **R2.6 — acceptance #7 + #8:** #7 — a turn while a task runs doesn't block the conversation (a `CONVERSATIONAL_ONLY` turn answers while the task keeps running). #8 — a mid-task change is queued / attached-pre-dispatch / sibling — **never injected or dropped** (assert: running-ATTACH → a persisted deferral exists, the running job is untouched; pre-dispatch-ATTACH → attaches; ambiguous → a `routing_ask` proposal posted).

**Out of scope (Plan D / later):** the classify-before-answer first-token reorder; the full legacy-routing migration; the richer semantic ATTACH/SIBLING classifier.
