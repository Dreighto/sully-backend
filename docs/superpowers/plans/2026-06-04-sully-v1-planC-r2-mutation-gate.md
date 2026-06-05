# Sully v1 — Plan C / Refactor 2: the Mutation Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Builds on the merged R1 substrate (`getActiveTaskForThread`, `PRE_DISPATCH_STATES`/`RUNNING_STATES`, `prepareTurnLifecycle`).

**Goal:** When the operator talks while a task is **running**, Sully never silently injects into or drops that work. Conversation flows; a work-intent turn during a running task triggers an **ask** ("hold it until this finishes, or run it separately?") whose answer becomes **defer** or **sibling**. (Proves acceptance #7 + #8; spec Contract 2.)

**Architecture:** A pure `mutation_gate.ts` reads the active task (R1 primitive). Its result rides on the turn context (from `prepareTurnLifecycle`). `maybeAutonomousDispatch` honors it: `CONVERSATIONAL_ONLY` → never dispatch (just talk; task keeps running); `RUNNING_WORK_INTENT` → do NOT touch the running task — post a **routing-ask** (stored as a `routing_ask` proposal holding the work content); the operator's next-turn answer (`isRoutingAnswer`) → **DEFER** (persist + "I'll bring it up when this finishes") or **SIBLING** (mint a new task with the held content). A hard backstop: `dispatchToWorker` rejects any payload update for a task past `dispatched`.

**Tech Stack:** SvelteKit server, better-sqlite3, vitest.

**v1 scope (operator's core concern = running work):** conversational / defer / sibling / ask, with a structural no-silent-mutation guarantee. **Deferred (noted, follow-ups):** pre-dispatch ATTACH-augment of a gated proposal (entangles with ask-before-dispatch; the running case is the real risk); auto-reinjection of a deferred turn when the task terminates (v1 = persist + notify; the operator is told, nothing is dropped); the classify-before-answer reorder so the ask replaces the reply instead of following it (that's Plan D).

---

## Task R2.0: the pure Mutation Gate

**Files:** Create `src/lib/server/routing/mutation_gate.ts`, `tests/mutation-gate.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/mutation-gate.test.ts` (DB-backed: seed active tasks in various states):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
const DB = '/tmp/sully-mutation-gate-test.db';
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

async function seedRunning(threadId: string) {
	const j = await import('$lib/server/dispatchJobs');
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	bootstrapCompanionDb();
	j.createJob({
		traceId: `r-${threadId}`,
		worker: 'claude-code',
		category: 'code',
		brief: 'x',
		fingerprint: 'f',
		predictedTokens: 0,
		threadId
	});
	j.markDispatched(`r-${threadId}`); // RUNNING
}

describe('runMutationGate', () => {
	it('no active task → NO_ACTIVE_TASK', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const { runMutationGate } = await import('$lib/server/routing/mutation_gate');
		expect(runMutationGate('t0', 'build me a thing').classification).toBe('NO_ACTIVE_TASK');
	});
	it('running task + plain conversation → CONVERSATIONAL_ONLY', async () => {
		await seedRunning('t1');
		const { runMutationGate } = await import('$lib/server/routing/mutation_gate');
		expect(runMutationGate('t1', 'thanks, that makes sense').classification).toBe(
			'CONVERSATIONAL_ONLY'
		);
		expect(runMutationGate('t1', 'what do you think of the rabbit icon?').classification).toBe(
			'CONVERSATIONAL_ONLY'
		);
	});
	it('running task + work intent → RUNNING_WORK_INTENT (never silently dispatched)', async () => {
		await seedRunning('t2');
		const { runMutationGate } = await import('$lib/server/routing/mutation_gate');
		const r = runMutationGate('t2', 'also audit the console repo and fix the build');
		expect(r.classification).toBe('RUNNING_WORK_INTENT');
		expect(r.activeTaskId).toBe('r-t2');
	});
	it('pre-dispatch (gated) active task → NO_ACTIVE_TASK (left to ask-before-dispatch)', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		j.proposeTask({ taskId: 'g1', threadId: 't3', source: 'chat', category: 'code', brief: 'x' });
		j.markClassified('g1', 'chat', null);
		j.markGatedProposal('g1', {
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			targetRepo: 'companion',
			task: 'x'
		});
		const { runMutationGate } = await import('$lib/server/routing/mutation_gate');
		expect(runMutationGate('t3', 'also do this other thing').classification).toBe('NO_ACTIVE_TASK');
	});
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run tests/mutation-gate.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/lib/server/routing/mutation_gate.ts`:**

```ts
// The Mutation Gate (spec Contract 2). Pure read of the active task — decides
// whether a turn taken WHILE A TASK IS RUNNING is plain conversation or a
// work-intent that must NOT silently touch the running task. Pre-dispatch
// (gated proposal) tasks are left to the existing ask-before-dispatch flow.
import { getActiveTaskForThread, RUNNING_STATES, type PendingJob } from '$lib/server/dispatchJobs';

export type MutationClass = 'NO_ACTIVE_TASK' | 'CONVERSATIONAL_ONLY' | 'RUNNING_WORK_INTENT';
export interface MutationGateResult {
	classification: MutationClass;
	activeTaskId: string | null;
	activeTaskStatus: string | null;
}

// Work-intent signal: imperative verbs with an object, or an @mention. Mirrors
// the spirit of decide()'s value gate but local + cheap. Conservative — when
// unsure, treat as conversation (safe: we never silently mutate; worst case a
// real work request during a running task is answered as chat, which the
// operator can re-issue once the task finishes).
const WORK_INTENT_RE =
	/@cc\b|@agy\b|@gemini\b|\b(build|implement|create|generate|add|write|fix|patch|refactor|audit|review|run|inspect|check|verify|diagnose|deploy|migrate|update|change|delete|remove|test|investigate)\b/i;

export function runMutationGate(threadId: string, userText: string): MutationGateResult {
	const active: PendingJob | null = getActiveTaskForThread(threadId);
	if (!active)
		return { classification: 'NO_ACTIVE_TASK', activeTaskId: null, activeTaskStatus: null };
	// Only RUNNING tasks gate here; pre-dispatch (gated proposals) are handled by
	// ask-before-dispatch, so the gate is a no-op for them.
	if (!RUNNING_STATES.has(active.status)) {
		return { classification: 'NO_ACTIVE_TASK', activeTaskId: null, activeTaskStatus: null };
	}
	const work = WORK_INTENT_RE.test(userText || '');
	return {
		classification: work ? 'RUNNING_WORK_INTENT' : 'CONVERSATIONAL_ONLY',
		activeTaskId: active.trace_id,
		activeTaskStatus: active.status
	};
}
```

- [ ] **Step 4: Run, verify pass.** `npx vitest run tests/mutation-gate.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git add src/lib/server/routing/mutation_gate.ts tests/mutation-gate.test.ts && git commit -m "feat(planC): pure Mutation Gate — running-task work-intent vs conversation"`

---

## Task R2.1: routing-ask plumbing — `proposal_type` + `isRoutingAnswer`

**Files:** Modify `src/lib/server/dispatchJobs.ts` (markGatedProposal + getPendingProposal expose `proposal_type`), `src/lib/server/routing/confirm.ts` (add `isRoutingAnswer`); Tests `tests/routing-ask.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/routing-ask.test.ts`: `isRoutingAnswer('hold it')==='defer'`, `isRoutingAnswer('run it separately')==='sibling'`, `isRoutingAnswer('what time is it')===null`; and a gated proposal stamped with `proposal_type:'routing_ask'` round-trips via `getPendingProposal` (which exposes `proposal_type`, defaulting missing → `'dispatch'`).

```ts
import { describe, it, expect } from 'vitest';
import { isRoutingAnswer } from '$lib/server/routing/confirm';
describe('isRoutingAnswer', () => {
	it('defer answers', () => {
		for (const t of ['hold it', 'wait until that finishes', 'after this one', 'hold that', 'later'])
			expect(isRoutingAnswer(t)).toBe('defer');
	});
	it('sibling answers', () => {
		for (const t of [
			'run it separately',
			'start a separate one',
			'a new task',
			'do it now too',
			'separately'
		])
			expect(isRoutingAnswer(t)).toBe('sibling');
	});
	it('non-answers → null', () => {
		for (const t of ['what time is it', 'thanks', 'build a dashboard'])
			expect(isRoutingAnswer(t)).toBeNull();
	});
});
```

(Plus a DB test: `markGatedProposal(taskId, payload, 'routing_ask')` → `getPendingProposal(threadId)?.proposalType === 'routing_ask'`; legacy rows without the field → `'dispatch'`.)

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `confirm.ts` add `isRoutingAnswer(text): 'defer' | 'sibling' | null` (conservative phrase sets, apostrophe-stripped like `isAffirmation`). `dispatchJobs.ts`: `markGatedProposal(traceId, proposal, proposalType: 'dispatch' | 'routing_ask' = 'dispatch')` stamps `proposal_type` into the `result_ref` JSON; `getPendingProposal`/`getProposalByTaskId` parse + expose `proposalType` (missing → `'dispatch'`). No schema change (JSON in `result_ref`).
- [ ] **Step 4: Run, verify pass.** Existing ask-before-dispatch tests must stay green (the default `'dispatch'` preserves behavior).
- [ ] **Step 5: Commit.** `git add ... && git commit -m "feat(planC): proposal_type discriminator + isRoutingAnswer (routing-ask plumbing)"`

---

## Task R2.2: wire the gate into the turn + honor it (no silent mutation)

**Files:** Modify `src/lib/server/chat/stream_prepare.ts` (`prepareTurnLifecycle` runs the gate → `MutationGateResult` on the result + `PreparedStreamContext`), `src/lib/server/chat/autonomous_dispatch.ts` (honor the gate), `src/lib/server/companionDispatch.ts` (dispatch rejection backstop)

- [ ] **Step 1:** In `prepareTurnLifecycle`, after classify, call `runMutationGate(threadId, text)` and include `mutationGate: MutationGateResult` as a **required** field on its return + on `PreparedStreamContext`. (Compile-enforced: the turn can't proceed without the gate result.) Pass it into `maybeAutonomousDispatch` (add `mutationGate?: MutationGateResult` to `AutonomousDispatchArgs`; both route handlers already have `ctx` → pass `ctx.mutationGate`).

- [ ] **Step 2: Honor the gate at the TOP of `maybeAutonomousDispatch`** (before the existing pending-proposal/decide flow):
  - **First**, if there's a pending `routing_ask` proposal on the thread and `isRoutingAnswer(userText)` resolves: `'sibling'` → dispatch a NEW task from the held content (the proposal's stored `task`/`brief`); `'defer'` → `markAborted` the routing-ask + persist a deferral note + post "Okay — I'll hold that until the current task finishes." Consume the routing_ask either way. Return.
  - **Else** branch on `args.mutationGate?.classification`:
    - `RUNNING_WORK_INTENT` → **do NOT dispatch.** Store a `routing_ask` gated proposal holding this turn's work content (`markGatedProposal(taskId, {worker, category, brief: userText.slice(0,200), targetRepo, task: userText}, 'routing_ask')`) and post: `addChatMessage('local', "I've got a task running — want me to hold this until it finishes, or run it as a separate task?", taskId, …, 'pending_approval', threadId)`. Return `{ spokenSuffix }`. **The running task is never touched.**
    - `CONVERSATIONAL_ONLY` → close the turn as self-handled (no dispatch); the running task keeps going. Return `{}`.
    - `NO_ACTIVE_TASK` (or undefined) → fall through to the existing flow unchanged.

- [ ] **Step 3: Dispatch rejection backstop** in `companionDispatch.ts` `dispatchToWorker`: before upserting, if a job row for `traceId` already exists in a state past `dispatched` (`RUNNING_STATES` minus `decided`, i.e. dispatched/working/retry, or any terminal), reject (return `{ ok:false, reason:'task already in flight — cannot mutate' }`) rather than mutating it. (Hard structural guard against mid-flight mutation — complements the gate.)

- [ ] **Step 4:** `npm run check` + `npx vitest run` → green. Existing dispatch/ask-before-dispatch/voice/text tests must stay green (the gate is a no-op when there's no RUNNING active task, which is the case in all existing tests).
- [ ] **Step 5: Commit.** `git add ... && git commit -m "feat(planC): honor the Mutation Gate — running-task work-intent asks (defer/sibling), never injects"`

---

## Task R2.3: acceptance #7 + #8

**Files:** Create `tests/mutation-acceptance.test.ts`

- [ ] **Step 1: Write the acceptance test** — drive `maybeAutonomousDispatch` with a seeded RUNNING task on the thread (mock `dispatchToWorker`):
  - **#7 — conversation isn't blocked:** RUNNING task + "thanks, looks good" → gate `CONVERSATIONAL_ONLY` → `maybeAutonomousDispatch` does NOT call `dispatchToWorker`; the running task row is untouched (status still `dispatched`).
  - **#8a — work-intent during running → ask, never inject:** RUNNING task + "also fix the console build" → no `dispatchToWorker` call; a `routing_ask` proposal is posted (status `pending_approval`); the running task row is untouched.
  - **#8b — answer "separately" → sibling:** with the routing_ask pending, "run it separately" → `dispatchToWorker` called for a NEW trace (not the running one); routing_ask consumed.
  - **#8c — answer "hold it" → defer, nothing dropped:** with the routing_ask pending, "hold it" → no dispatch; a "I'll hold that" message posted; routing_ask consumed; the held content is recorded (journal/abort reason), not lost.

- [ ] **Step 2: Run.** `npx vitest run tests/mutation-acceptance.test.ts` → PASS. Then FULL `npx vitest run` + `npm run check` → green.
- [ ] **Step 3: Commit.** `git add tests/mutation-acceptance.test.ts && git commit -m "test(planC): acceptance #7 (conversation flows) + #8 (never inject/drop running work)"`

---

## Final review

- [ ] Full suite + `npm run check` green.
- [ ] Adversarial review (focus: **no path injects into / drops a running task**; the gate is a no-op when no RUNNING task; the routing_ask never collides with a dispatch proposal; the dispatch-rejection backstop; conversation truly isn't blocked).
- [ ] **Note for follow-ups (NOT this PR):** pre-dispatch ATTACH-augment; auto-reinjection of a deferred turn on task terminal; the Plan D classify-before-answer reorder (so the ask replaces the reply instead of following it). Operator live-QA + merge.
