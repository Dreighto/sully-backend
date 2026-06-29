# Sully Routing Scorecard + Close-the-Loops — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sully's task lifecycle reliably terminate + record its decisions, then add an offline, CI-gated routing scorecard that grades her Talk/Ask/Dispatch decisions and lets us fix the obvious misfires safely.

**Architecture:** Phase 0 closes built-but-dark loops with small surgical fixes (classification write-back, race-free completion, self-handled terminal, stale reaper). Phase 1 extracts the dispatch decision into one pure `decide()` function, builds a labeled JSONL fixture corpus + a pure scorecard module, enforces it as a hard CI gate via vitest, then layers two scorecard-validated behavior fixes (tier-suppression + regex tightening).

**Tech Stack:** SvelteKit (adapter-node), TypeScript, better-sqlite3, vitest 4, `$lib` alias, `$env/dynamic/private` (mocked in DB tests). Companion repo `~/dev/LogueOS-Companion`, server `:18769`.

**Spec:** `data/peer_reviews/2026-06-03_sully-routing-scorecard-phase0-1_design.md` · **Gap audit:** `data/peer_reviews/2026-06-03_sully-vision-gap-audit.md`

**Conventions to follow (verified in repo):**

- DB tests use a temp DB at `/tmp/sully-*-test.db`, `vi.mock('$env/dynamic/private', () => ({ env: ENV }))`, `beforeEach` deletes + recreates the file + `vi.resetModules()`, and `await import('$lib/server/...')` AFTER the mock (see `tests/dispatch-jobs.test.ts`).
- Pure-function tests need no DB mock (see `tests/decision-gate.test.ts`).
- `npm test` = `vitest run` (runs in `.github/workflows/ci.yml`). `npm run check` = svelte-check.
- Commit after every green task. Branch off `main`; end on `main` clean (operator rule).

---

## Pre-flight

- [ ] **Step 1: Branch**

```bash
cd ~/dev/LogueOS-Companion
git checkout main && git pull --ff-only
git checkout -b feat/routing-scorecard-phase0-1
```

- [ ] **Step 2: Baseline green**

Run: `npm run check && npm test`
Expected: svelte-check 0 errors; all tests pass (134 today).

---

## Phase 0 — Close the loops

### Task 1: Persist the classifier tier onto the Task row

**Why:** `classification_tier` is NULL on 100% of rows — the tier is computed + journaled but never written to `pending_jobs`. No `markClassified` helper exists.

**Files:**

- Modify: `src/lib/server/dispatchJobs.ts` (add `markClassified`)
- Modify: `src/lib/server/chat_turn.ts:94-110` (call it from `classifyAndTouchThread`)
- Test: `tests/routing-lifecycle.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/routing-lifecycle.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-routing-lifecycle-test.db';
const ENV = { LOGUEOS_APP_MODE: 'companion', LOGUEOS_MEMORY_DB_PATH: DB };
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

describe('markClassified', () => {
	it('writes the tier onto the proposed Task row and advances it to classified', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.proposeTask({
			taskId: 'sully-c1',
			threadId: 't1',
			source: 'chat',
			category: 'general',
			brief: 'hi'
		});
		j.markClassified('sully-c1', 'planning', JSON.stringify({ reason: 'phrase' }));
		const row = j.getJob('sully-c1');
		expect(row?.status).toBe('classified');
		expect(row?.classification_tier).toBe('planning');
	});

	it('is idempotent — a second call just refreshes the tier, never throws', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.proposeTask({
			taskId: 'sully-c2',
			threadId: 't1',
			source: 'chat',
			category: 'general',
			brief: 'hi'
		});
		j.markClassified('sully-c2', 'chat', null);
		expect(() => j.markClassified('sully-c2', 'deep', null)).not.toThrow();
		expect(j.getJob('sully-c2')?.classification_tier).toBe('deep');
	});
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- tests/routing-lifecycle.test.ts`
Expected: FAIL — `j.markClassified is not a function`.

- [ ] **Step 3: Add `markClassified` to `dispatchJobs.ts`**

Insert after `markSynthesized` (after line 295):

```typescript
/**
 * Phase 0: record the L1 classifier's tier on the Task row. Status-guarded +
 * idempotent: proposed→classified the first time; on a later call (or any
 * already-advanced status) it just refreshes the tier columns without forcing
 * an illegal FSM transition. Never throws into the turn pipeline.
 */
export function markClassified(traceId: string, tier: string, payload: string | null): void {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return;
	const db = getDb();
	try {
		const row = db.prepare('SELECT status FROM pending_jobs WHERE trace_id = ?').get(traceId) as
			| { status: JobStatus }
			| undefined;
		if (!row) return;
		const nextStatus = row.status === 'proposed' ? 'classified' : row.status;
		db.prepare(
			'UPDATE pending_jobs SET status = ?, classification_tier = ?, classification_payload = ? WHERE trace_id = ?'
		).run(nextStatus, tier, payload, traceId);
	} finally {
		db.close();
	}
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm test -- tests/routing-lifecycle.test.ts`
Expected: PASS (both `markClassified` cases).

- [ ] **Step 5: Wire it into `classifyAndTouchThread`**

In `src/lib/server/chat_turn.ts`, add `markClassified` to the dispatchJobs import (top of file already imports `proposeTask` from `./dispatchJobs`):

```typescript
import { proposeTask, markClassified } from './dispatchJobs';
```

Then in `classifyAndTouchThread`, replace the existing `if (args.taskId) { logTaskEvent(...) }` block (lines ~105-110) with:

```typescript
if (args.taskId) {
	markClassified(
		args.taskId,
		currentTier,
		JSON.stringify({ operator_override: threadState.operator_override ?? null })
	);
	logTaskEvent(args.taskId, 'classifier_ran', {
		tier: currentTier,
		operator_override: threadState.operator_override ?? null
	});
}
```

- [ ] **Step 6: Type-check + full test run**

Run: `npm run check && npm test`
Expected: 0 type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/dispatchJobs.ts src/lib/server/chat_turn.ts tests/routing-lifecycle.test.ts
git commit -m "fix(lifecycle): persist classifier tier onto the Task row (markClassified)"
```

---

### Task 2: Race-free completion close-out

**Why:** (a) every `done` job has empty `thread_id`, so `closeOutTask` posts to `'default'` because `?? 'default'` never fires on `''`; (b) a `completed` callback arriving after the job is already `aborted`/`failed` throws an illegal `markDone` and the whole `try` block is skipped, so nothing posts.

**Files:**

- Modify: `src/routes/api/chat/activity/+server.ts:33-44` (thread resolution) and `:124-139` (decouple close-out from `markDone`)
- Test: `tests/activity-closeout.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/activity-closeout.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-activity-closeout-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DISPATCH_ENABLED: 'true'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

describe('resolveCompletionThread', () => {
	it('treats an empty-string thread_id as missing → default', async () => {
		const { resolveCompletionThread } = await import('$lib/server/completionClose');
		expect(resolveCompletionThread('')).toBe('default');
		expect(resolveCompletionThread(null)).toBe('default');
		expect(resolveCompletionThread('thread-42')).toBe('thread-42');
	});
});

describe('closeOutTask race', () => {
	it('still posts the result when the job is already aborted (completed-after-abort)', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { closeOutTask } = await import('$lib/server/completionClose');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		j.createJob({
			traceId: 'sully-r1',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0,
			threadId: 'thread-9'
		});
		j.markAborted('sully-r1'); // job is terminal BEFORE the late callback
		closeOutTask('sully-r1', 'done', 'all done, PR #5 merged');
		const { getChatMessages } = await import('$lib/server/chat');
		const msgs = getChatMessages(50, 'thread-9');
		expect(msgs.some((m) => m.message.includes('all done, PR #5 merged'))).toBe(true);
	});
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- tests/activity-closeout.test.ts`
Expected: FAIL — `$lib/server/completionClose` does not exist.

- [ ] **Step 3: Extract close-out into a testable module**

Create `src/lib/server/completionClose.ts` (moves `closeOutTask` out of the route so it's importable + testable, and fixes both bugs):

```typescript
// Task close-out: post Sully's completion message into the originating thread,
// link it as the synthesis message, and fire a (self-gated) push. Extracted
// from the activity route so it is unit-testable and so BOTH bugs are fixed in
// one place: (1) empty-string thread_id must fall back to 'default'; (2) the
// post must happen even when the FSM rejects done→synthesized (e.g. a
// completed callback that lands after an abort) — synthesis is best-effort.
import { addChatMessage } from './chat';
import { logTaskEvent } from './chatActivity';
import { getJob, markSynthesized } from './dispatchJobs';
import { appIdentity } from './config';
import { sendPushToAll } from './web_push';
import { sendApnsToAll } from './apns';

/** Empty string OR null/undefined thread_id → 'default'. (`??` alone misses ''.) */
export function resolveCompletionThread(threadId: string | null | undefined): string {
	return threadId && threadId.trim() ? threadId : 'default';
}

export function closeOutTask(
	traceId: string,
	outcome: 'done' | 'failed',
	resultText: string
): void {
	const job = getJob(traceId);
	const threadId = resolveCompletionThread(job?.thread_id);
	const text = resultText.trim();
	const msg =
		outcome === 'done'
			? text
				? `Done. Here's what came back:\n\n${text}`
				: `That's finished — the task completed cleanly.`
			: text
				? `That one hit a snag: ${text}`
				: `That one didn't complete — I'll need another look.`;
	try {
		const row = addChatMessage('local', msg, traceId, null, null, 'sent', threadId, {
			taskId: traceId
		});
		logTaskEvent(traceId, 'synthesis_completed', { outcome, via: 'worker-result' });
		// Best-effort link — FSM may reject the transition from a terminal state;
		// the operator-facing message above has ALREADY landed regardless.
		try {
			markSynthesized(traceId, row.id);
		} catch {
			/* already terminal (aborted/failed/synthesized) — non-fatal */
		}
	} catch (e) {
		console.error('[completionClose] message failed', e);
	}
	const pushPayload = {
		title: outcome === 'done' ? 'Sully — task done' : 'Sully — task needs you',
		body: outcome === 'done' ? 'Your task finished. Tap to see the result.' : 'A task hit a snag.',
		url: appIdentity.pushDefaultUrl
	};
	void sendPushToAll(pushPayload).catch((e) =>
		console.error('[completionClose] web push failed', e)
	);
	void sendApnsToAll(pushPayload).catch((e) =>
		console.error('[completionClose] apns push failed', e)
	);
}
```

- [ ] **Step 4: Point the route at the extracted module**

In `src/routes/api/chat/activity/+server.ts`: delete the local `closeOutTask` function (lines 22-68) and its now-unused imports (`markSynthesized`, `addChatMessage`, `sendPushToAll`, `sendApnsToAll`, `appIdentity`). Add at the top:

```typescript
import { closeOutTask } from '$lib/server/completionClose';
```

Then make the `completed`/`failed` callbacks post even if the transition throws — replace the `try { ... } catch` block (lines 124-139) with:

```typescript
try {
	if (action === 'completed') {
		if (body.marker) captureActualTokens(trace_id, body.marker);
		try {
			markDone(trace_id, body.result_ref ?? null);
		} catch (e) {
			// Late callback after abort/fail — log + still close out below.
			console.warn('activity markDone transition skipped:', e);
		}
		closeOutTask(trace_id, 'done', body.result_ref ?? '');
	} else if (action === 'failed') {
		try {
			markFailed(trace_id, body.target ?? null);
		} catch (e) {
			console.warn('activity markFailed transition skipped:', e);
		}
		closeOutTask(trace_id, 'failed', body.target ?? '');
	} else {
		markWorking(trace_id, body.target ? `${action} ${body.target}` : action);
	}
} catch (e) {
	console.warn('activity callback transition skipped:', e);
}
```

(Leave `markWorking`, `markDone`, `markFailed`, `getJob`, `captureActualTokens`, `writeActivity`, `logTaskEvent` imports — `markDone`/`markFailed` are still called.)

- [ ] **Step 5: Run it — expect PASS**

Run: `npm test -- tests/activity-closeout.test.ts`
Expected: PASS (both describes).

- [ ] **Step 6: Type-check + full test run**

Run: `npm run check && npm test`
Expected: 0 type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/completionClose.ts src/routes/api/chat/activity/+server.ts tests/activity-closeout.test.ts
git commit -m "fix(completion): route close-out to the live thread + post even after a late terminal callback"
```

---

### Task 3: Self-handled turns reach a real terminal (`synthesized`)

**Why:** 27/41 self-handled chat/voice turns die at `proposed`. When no worker fires, link Sully's reply as the synthesis message and close the arc.

**Files:**

- Modify: `src/lib/server/dispatchJobs.ts` (add `markSelfHandled`)
- Modify: `src/lib/server/chat/autonomous_dispatch.ts` (call it on the no-dispatch branch)
- Test: `tests/routing-lifecycle.test.ts` (extend)

- [ ] **Step 1: Add the failing test (append to `tests/routing-lifecycle.test.ts`)**

```typescript
describe('markSelfHandled', () => {
	it('links the latest reply + synthesizes a proposed/classified self-handled turn', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		const { addChatMessage } = await import('$lib/server/chat');
		bootstrapCompanionDb();
		j.proposeTask({
			taskId: 'sully-s1',
			threadId: 't1',
			source: 'chat',
			category: 'general',
			brief: 'hey'
		});
		j.markClassified('sully-s1', 'chat', null);
		const reply = addChatMessage('local', 'hi there', 'sully-s1', null, null, 'sent', 't1', {
			taskId: 'sully-s1'
		});
		j.markSelfHandled('sully-s1');
		const row = j.getJob('sully-s1');
		expect(row?.status).toBe('synthesized');
		expect(row?.synthesis_message_id).toBe(reply.id);
	});

	it('leaves an already-dispatched job alone (no clobber)', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.createJob({
			traceId: 'sully-s2',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0,
			threadId: 't1'
		});
		j.markDispatched('sully-s2');
		j.markSelfHandled('sully-s2'); // must be a no-op — status is 'dispatched'
		expect(j.getJob('sully-s2')?.status).toBe('dispatched');
	});
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- tests/routing-lifecycle.test.ts`
Expected: FAIL — `j.markSelfHandled is not a function`.

- [ ] **Step 3: Add `markSelfHandled` to `dispatchJobs.ts`**

Insert after `markClassified`:

```typescript
/**
 * Phase 0: close the arc for a SELF-HANDLED turn (no worker dispatched). Links
 * Sully's own reply as the synthesis message and transitions to 'synthesized'.
 * Status-guarded to proposed/classified so it can NEVER clobber a turn that
 * went on to dispatch (those close out via the worker-completion path instead).
 * Direct UPDATE (not transition()) since proposed/classified→synthesized are
 * both legal sinks and we don't want to throw on a benign re-entry.
 */
export function markSelfHandled(traceId: string): void {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return;
	const db = getDb();
	try {
		const row = db.prepare('SELECT status FROM pending_jobs WHERE trace_id = ?').get(traceId) as
			| { status: JobStatus }
			| undefined;
		if (!row || (row.status !== 'proposed' && row.status !== 'classified')) return;
		const reply = db
			.prepare(
				`SELECT id FROM chat_messages
				 WHERE task_id = ? AND sender IN ('local','cc','agy','companion')
				 ORDER BY id DESC LIMIT 1`
			)
			.get(traceId) as { id: number } | undefined;
		db.prepare(
			"UPDATE pending_jobs SET status = 'synthesized', synthesis_message_id = ?, ended_at = ? WHERE trace_id = ?"
		).run(reply?.id ?? null, new Date().toISOString(), traceId);
	} finally {
		db.close();
	}
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm test -- tests/routing-lifecycle.test.ts`
Expected: PASS (all `markSelfHandled` + earlier cases).

- [ ] **Step 5: Call it from the no-dispatch branch**

This wiring happens together with the `decide()` refactor in **Task 7** (the no-dispatch branch is rewritten there). Add a placeholder note now; the actual call (`if (d.action !== 'Dispatch') markSelfHandled(taskId);`) is in Task 7, Step 4.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/dispatchJobs.ts tests/routing-lifecycle.test.ts
git commit -m "feat(lifecycle): markSelfHandled — close the arc for self-handled turns"
```

---

### Task 4: Stale-job reaper

**Why:** 2 jobs are stuck `dispatched`/`working` for ~2 days with no terminal callback. Sweep them to `failed` + tell the operator.

**Files:**

- Modify: `src/lib/server/dispatchJobs.ts` (add `reapStaleJobs`)
- Modify: `src/routes/api/chat/activity/+server.ts` (call opportunistically on the polled GET)
- Test: `tests/routing-lifecycle.test.ts` (extend)

- [ ] **Step 1: Add the failing test (append to `tests/routing-lifecycle.test.ts`)**

```typescript
describe('reapStaleJobs', () => {
	it('fails a job stuck in dispatched/working past the timeout and returns it', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const Database = (await import('better-sqlite3')).default;
		j.createJob({
			traceId: 'sully-old',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0,
			threadId: 't1'
		});
		j.markDispatched('sully-old');
		// Backdate started_at to 2 days ago.
		const db = new Database(DB);
		db.prepare("UPDATE pending_jobs SET started_at = ? WHERE trace_id = 'sully-old'").run(
			'2000-01-01T00:00:00.000Z'
		);
		db.close();
		const reaped = j.reapStaleJobs(60_000);
		expect(reaped.map((r) => r.trace_id)).toContain('sully-old');
		expect(j.getJob('sully-old')?.status).toBe('failed');
	});

	it('leaves a fresh in-flight job alone', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.createJob({
			traceId: 'sully-fresh',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'g',
			predictedTokens: 0,
			threadId: 't1'
		});
		j.markDispatched('sully-fresh');
		expect(j.reapStaleJobs(60_000).map((r) => r.trace_id)).not.toContain('sully-fresh');
		expect(j.getJob('sully-fresh')?.status).toBe('dispatched');
	});
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- tests/routing-lifecycle.test.ts`
Expected: FAIL — `j.reapStaleJobs is not a function`.

- [ ] **Step 3: Add `reapStaleJobs` to `dispatchJobs.ts`**

Insert after `listInFlight`:

```typescript
/**
 * Phase 0: mark jobs FAILED when they have been in-flight (dispatched/working)
 * longer than timeoutMs with no terminal callback — a dropped worker. Returns
 * the rows it reaped so the caller can surface a "that task stalled" message.
 * Default 15 min. started_at is the anchor (the only monotonic timestamp we
 * reliably set at dispatch).
 */
export function reapStaleJobs(timeoutMs = 15 * 60 * 1000): PendingJob[] {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = getDb();
	try {
		const cutoff = new Date(Date.now() - timeoutMs).toISOString();
		const stale = db
			.prepare(
				`SELECT * FROM pending_jobs WHERE status IN ('dispatched','working') AND started_at < ?`
			)
			.all(cutoff) as PendingJob[];
		const now = new Date().toISOString();
		for (const s of stale) {
			db.prepare(
				"UPDATE pending_jobs SET status = 'failed', current_activity = 'stalled: no worker callback within timeout', ended_at = ? WHERE trace_id = ?"
			).run(now, s.trace_id);
		}
		return stale;
	} finally {
		db.close();
	}
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm test -- tests/routing-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Call the reaper from the polled activity GET**

In `src/routes/api/chat/activity/+server.ts`, import the reaper and `addChatMessage` + `resolveCompletionThread`:

```typescript
import { markWorking, markDone, markFailed, getJob, reapStaleJobs } from '$lib/server/dispatchJobs';
import { addChatMessage } from '$lib/server/chat';
import { resolveCompletionThread } from '$lib/server/completionClose';
```

Add a throttled sweep helper above the `GET` handler:

```typescript
// The client polls this GET every ~3s; piggyback a throttled stale-job sweep on
// it so a dropped worker is surfaced without a separate timer. Throttle to once
// per 60s to keep the poll cheap.
let _lastReapMs = 0;
function maybeReap(): void {
	const now = Date.now();
	if (now - _lastReapMs < 60_000) return;
	_lastReapMs = now;
	try {
		for (const job of reapStaleJobs()) {
			const threadId = resolveCompletionThread(job.thread_id);
			addChatMessage(
				'local',
				`That task stalled — the worker never reported back. Want me to retry it?`,
				job.trace_id,
				null,
				null,
				'sent',
				threadId,
				{ taskId: job.trace_id }
			);
		}
	} catch (e) {
		console.warn('[activity] reap sweep skipped:', e);
	}
}
```

Then call `maybeReap();` as the first line inside the `GET` handler's `try` block (after the run-mode guard).

- [ ] **Step 6: Type-check + full test run**

Run: `npm run check && npm test`
Expected: 0 type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/dispatchJobs.ts src/routes/api/chat/activity/+server.ts tests/routing-lifecycle.test.ts
git commit -m "feat(lifecycle): stale-job reaper on the polled activity GET"
```

---

### Task 5: Runtime QA — one real dispatch end-to-end

**Why:** Operator rule — 200-OK + green tests have masked operator-visible regressions. Prove the closed loop live before moving on.

**Files:** none (verification only).

- [ ] **Step 1: Build + restart**

```bash
cd ~/dev/LogueOS-Companion
npm run build && sudo -n systemctl restart logueos-companion.service
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18769/companion/chat   # expect 200
```

- [ ] **Step 2: Drive a real dispatch from a live thread**

In the Sully UI (or via the chat API), send a message that forces dispatch, e.g. `@cc echo a one-line hello from the routing-QA test`. Note the thread you sent it from.

- [ ] **Step 3: Confirm the loop closed in the DB**

```bash
sqlite3 ~/dev/LogueOS-Companion/data/companion.db \
  "SELECT trace_id,status,thread_id,synthesis_message_id FROM pending_jobs ORDER BY id DESC LIMIT 3;"
```

Expected: the new job reaches `synthesized` with a non-empty `thread_id` and a non-null `synthesis_message_id`.

- [ ] **Step 4: Confirm the completion message landed in the RIGHT thread**

```bash
sqlite3 ~/dev/LogueOS-Companion/data/companion.db \
  "SELECT sender,substr(message,1,60),thread_id FROM chat_messages ORDER BY id DESC LIMIT 4;"
```

Expected: a `local` "Done. Here's what came back…" row in the thread you used (NOT `default`).

- [ ] **Step 5: Record the result**

If all green, note it in the PR description. If not, STOP and debug Tasks 2-3 before continuing.

---

## Phase 1 — The routing scorecard

### Task 6: Pure `decide()` — behavior-preserving extraction

**Why:** The combined fire/talk decision is inlined in `autonomous_dispatch.ts`'s CLI-vs-direct branches and can't be unit-tested or scored as one unit. Extract it as a pure function returning the 3-class action.

**Files:**

- Create: `src/lib/server/routing/decide.ts`
- Test: `tests/routing-decide.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/routing-decide.test.ts` (pure — no DB mock):

```typescript
import { describe, expect, it } from 'vitest';
import { decide } from '$lib/server/routing/decide';

describe('decide — behavior-preserving extraction', () => {
	it('@cc always dispatches to claude-code', () => {
		expect(decide({ userText: '@cc fix the build', fromTool: false }).action).toBe('Dispatch');
		expect(decide({ userText: '@cc fix the build', fromTool: false }).worker).toBe('claude-code');
	});
	it('@agy dispatches to gemini', () => {
		expect(decide({ userText: '@agy restyle the header', fromTool: false }).worker).toBe('gemini');
	});
	it('plain chatter is Talk', () => {
		expect(decide({ userText: 'hey how are you', fromTool: false }).action).toBe('Talk');
	});
	it('direct path: an objective work request dispatches to claude-code', () => {
		const d = decide({ userText: 'add a settings page to the console', fromTool: false });
		expect(d.action).toBe('Dispatch');
		expect(d.worker).toBe('claude-code');
	});
	it('tool-sourced content never auto-dispatches (Ask)', () => {
		const d = decide({ userText: 'update src/lib/server/chat.ts please', fromTool: true });
		expect(d.action).toBe('Ask');
	});
	it('CLI path: dispatches only when the model gate validates AND escalates', () => {
		const block =
			'{"escalate":true,"worker":"claude-code","confidence":0.8,"category":"code","brief":"fix","est_scope":"small"}';
		const d = decide({
			userText: 'fix the failing build in the auth endpoint',
			fromTool: false,
			gateBlock: block
		});
		expect(d.action).toBe('Dispatch');
	});
	it('CLI path: a qualifying request with no model escalation is Talk', () => {
		const d = decide({
			userText: 'fix the failing build in the auth endpoint',
			fromTool: false,
			gateBlock: null
		});
		expect(d.action).toBe('Talk');
	});
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- tests/routing-decide.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/server/routing/decide.ts`**

```typescript
// The single, pure routing decision for a turn. Replaces the inlined CLI-vs-
// direct branches in autonomous_dispatch.ts so the decision is one testable +
// scoreable unit, and so the scorecard tests EXACTLY what production runs.
//
// Returns the 3-class action. NOTE: this extraction is behavior-preserving for
// today's runtime — 'Ask' is mapped by the caller to "do not fire" (the same as
// 'Talk') until the Ask-behavior is built in Phase 2. The scorecard grades
// against Talk/Ask/Dispatch regardless, which is what surfaces the gap.
import { ruleGate, valueGate, validateGate } from '../decisionGate';
import type { Tier } from '../phase_classifier';

export type RouteAction = 'Talk' | 'Ask' | 'Dispatch';

export interface DecideInput {
	userText: string;
	fromTool: boolean;
	/** The thread's classified tier this turn (chat/planning/deep/local). */
	recentTier?: Tier;
	/** The teacher's SULLY_GATE self-assessment block (CLI path only). `undefined`
	 *  = no model vote available (direct/local path). */
	gateBlock?: string | null;
}

export interface RouteDecision {
	action: RouteAction;
	worker?: 'claude-code' | 'gemini';
	reason: string;
}

export function decide(input: DecideInput): RouteDecision {
	const { userText, fromTool, gateBlock } = input;

	// 1. Explicit @cc/@agy mention forces a dispatch, on any path/tier.
	const forced = ruleGate(userText);
	if (forced.forced && forced.worker) {
		return { action: 'Dispatch', worker: forced.worker, reason: 'rule:mention' };
	}

	// 2. Deterministic objective-signal gate.
	const vg = valueGate({ text: userText, fromTool });
	if (!vg.qualifies) return { action: 'Talk', reason: vg.reason };

	// 3. Injection guard — tool/pasted content must be confirmed, never auto-fired.
	if (vg.forceAsk) return { action: 'Ask', reason: 'tool-sourced' };

	// 4. Model-vote layer (CLI path only). When a gate block is present it MUST
	//    validate + escalate; otherwise the qualifying turn is talked, not fired.
	if (gateBlock !== undefined) {
		const gate = validateGate(gateBlock ?? null);
		if (!(gate.ok && gate.gate.escalate)) {
			return { action: 'Talk', reason: 'model-vote-no-escalate' };
		}
		return { action: 'Dispatch', worker: gate.gate.worker, reason: 'qualifies+model-vote' };
	}

	// 5. Direct/local path — deterministic qualification alone decides.
	return { action: 'Dispatch', worker: 'claude-code', reason: 'qualifies' };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm test -- tests/routing-decide.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Type-check + commit**

```bash
npm run check
git add src/lib/server/routing/decide.ts tests/routing-decide.test.ts
git commit -m "feat(routing): pure decide() — behavior-preserving 3-class extraction"
```

---

### Task 7: Wire `decide()` into `maybeAutonomousDispatch` (+ self-handled terminal)

**Why:** Make production call `decide()` so test and behavior can't drift; journal the route `reason`; close the arc on self-handled turns (Task 3, Step 5).

**Files:**

- Modify: `src/lib/server/chat/autonomous_dispatch.ts`
- Modify: `src/routes/api/chat/sdk-stream/+server.ts:314, 502` and `src/routes/api/chat/voice-reply/+server.ts:142` (pass `tier`)
- Test: `tests/companion-dispatch.test.ts` (verify behavior unchanged for Talk/Dispatch — extend if it exists; otherwise rely on `routing-decide.test.ts`)

- [ ] **Step 1: Rewrite `maybeAutonomousDispatch`**

Replace the body of `src/lib/server/chat/autonomous_dispatch.ts` from the imports through the end of the function. New imports block:

```typescript
import { addChatMessage } from '$lib/server/chat';
import { runMode } from '$lib/server/config';
import { validateGate } from '$lib/server/decisionGate';
import { decide } from '$lib/server/routing/decide';
import { dispatchToWorker } from '$lib/server/companionDispatch';
import { logTaskEvent } from '$lib/server/chatActivity';
import { mintTaskId } from '$lib/server/chat_turn';
import { markSelfHandled } from '$lib/server/dispatchJobs';
import type { Tier } from '$lib/server/phase_classifier';
```

Add `tier` to `AutonomousDispatchArgs`:

```typescript
	/** The thread's classified tier this turn — gates brainstorm suppression. */
	tier?: Tier;
```

New function body (replaces lines 64-150):

```typescript
export async function maybeAutonomousDispatch(args: AutonomousDispatchArgs): Promise<void> {
	if (!runMode.companionDispatchEnabled) return;

	const { userText, targetRepo, threadId } = args;
	const taskId = args.taskId ?? mintTaskId();

	const d = decide({
		userText,
		fromTool: false,
		recentTier: args.tier,
		gateBlock: args.gateBlock // undefined on the direct/local path
	});

	// Preserve brief/category derivation: prefer the teacher's gate block when present.
	const gate = args.gateBlock !== undefined ? validateGate(args.gateBlock ?? null) : null;
	const category = gate && gate.ok ? gate.gate.category : 'code';
	const brief = gate && gate.ok ? gate.gate.brief : userText.slice(0, 200);

	if (d.action === 'Dispatch' && d.worker) {
		const res = await dispatchToWorker({
			traceId: taskId,
			worker: d.worker,
			category,
			brief,
			targetRepo,
			task: userText,
			threadId
		});
		logTaskEvent(taskId, 'gate_evaluated', {
			action: d.action,
			reason: d.reason,
			worker: d.worker,
			category,
			dispatched: res.ok,
			held_reason: res.ok ? null : res.reason
		});
		addChatMessage(
			'system',
			res.ok
				? `On it — this one needs some real digging, so give me a few minutes. I'll drop the answer right here the moment it's ready.`
				: `⚠️ Dispatch held: ${res.reason}.`,
			res.ok ? taskId : null,
			null,
			null,
			'sent',
			threadId,
			{ taskId }
		);
		return;
	}

	// Talk or Ask — no worker fired this turn. Journal the routing decision (a
	// training pair for v3) AND close the self-handled arc (Phase 0 fix 0.3).
	logTaskEvent(taskId, 'gate_evaluated', { action: d.action, reason: d.reason, dispatched: false });
	markSelfHandled(taskId);
}
```

- [ ] **Step 2: Pass `tier` from the call sites**

In `src/routes/api/chat/sdk-stream/+server.ts`, the CLI-path call (~line 314):

```typescript
await maybeAutonomousDispatch({
	userText: userMessageText,
	targetRepo,
	threadId,
	gateBlock: block,
	taskId,
	tier: currentTier
});
```

The direct-path call (~line 502):

```typescript
void maybeAutonomousDispatch({
	userText: userMessageText,
	targetRepo,
	threadId,
	taskId,
	tier: currentTier
}).catch((e) => {
	console.error('[sdk-stream] autonomous-dispatch failed', e);
});
```

In `src/routes/api/chat/voice-reply/+server.ts` (~line 142), add `tier: currentTier` to the `maybeAutonomousDispatch({...})` call (the voice route has `currentTier` from `classifyAndTouchThread`).

- [ ] **Step 3: Run the dispatch tests + full suite**

Run: `npm run check && npm test`
Expected: 0 type errors; all tests pass. (Behavior for Talk/Dispatch is preserved; `tier` is unset in unit tests so the new brainstorm rule — added in Task 11 — doesn't yet change anything.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/server/chat/autonomous_dispatch.ts src/routes/api/chat/sdk-stream/+server.ts src/routes/api/chat/voice-reply/+server.ts
git commit -m "refactor(routing): autonomous dispatch calls decide(); journal reason; close self-handled arc"
```

---

### Task 8: Labeled fixture corpus + loader

**Files:**

- Create: `tests/fixtures/routing-cases.jsonl`
- Create: `src/lib/server/routing/fixtures.ts` (loader + types)
- Test: `tests/routing-fixtures.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/routing-fixtures.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { loadRoutingCases } from '$lib/server/routing/fixtures';

describe('routing fixtures', () => {
	it('loads ≥40 well-formed labeled cases', () => {
		const cases = loadRoutingCases();
		expect(cases.length).toBeGreaterThanOrEqual(40);
		for (const c of cases) {
			expect(typeof c.text).toBe('string');
			expect(['Talk', 'Ask', 'Dispatch']).toContain(c.expected);
			expect(typeof c.fromTool).toBe('boolean');
		}
	});
	it('includes the locked regression cases', () => {
		const locked = loadRoutingCases().filter((c) => c.locked);
		expect(locked.length).toBeGreaterThanOrEqual(4);
	});
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- tests/routing-fixtures.test.ts`
Expected: FAIL — loader missing.

- [ ] **Step 3: Create the loader `src/lib/server/routing/fixtures.ts`**

```typescript
import fs from 'node:fs';
import path from 'node:path';
import type { Tier } from '../phase_classifier';
import type { RouteAction } from './decide';

export interface RoutingCase {
	text: string;
	fromTool: boolean;
	tier?: Tier;
	gateBlock?: string | null;
	expected: RouteAction;
	note?: string;
	/** Locked cases must individually pass (hard regression gate). */
	locked?: boolean;
}

/** Loads tests/fixtures/routing-cases.jsonl (one JSON object per non-blank line). */
export function loadRoutingCases(
	file = path.resolve(process.cwd(), 'tests/fixtures/routing-cases.jsonl')
): RoutingCase[] {
	const raw = fs.readFileSync(file, 'utf8');
	return raw
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith('//'))
		.map((l) => JSON.parse(l) as RoutingCase);
}
```

- [ ] **Step 4: Create `tests/fixtures/routing-cases.jsonl`**

Seed with the cases below (real journal-derived + adversarial + everyday). At least 40 lines; `locked: true` on the regression-critical ones:

```jsonl
{"text":"@cc fix the failing build in the auth endpoint","fromTool":false,"expected":"Dispatch","locked":true,"note":"explicit @cc"}
{"text":"@agy restyle the chat header","fromTool":false,"expected":"Dispatch","note":"explicit @agy → gemini"}
{"text":"the main focus right now was the companion app in which I'm speaking to you now. so we're trying to get that wired up","fromTool":false,"tier":"planning","expected":"Talk","locked":true,"note":"brainstorm chatter; the real journal false-positive"}
{"text":"wire up the companion app","fromTool":false,"tier":"chat","expected":"Talk","locked":true,"note":"soft imperative + bare repo, no code target"}
{"text":"update the kernel news section","fromTool":false,"tier":"chat","expected":"Talk","locked":true,"note":"soft imperative + bare repo"}
{"text":"build a relationship with the console team","fromTool":false,"tier":"chat","expected":"Talk","note":"soft imperative + repo word, not a work order"}
{"text":"add a settings page to the console","fromTool":false,"tier":"chat","expected":"Dispatch","note":"strong imperative + repo"}
{"text":"fix the failing build in the auth endpoint","fromTool":false,"tier":"chat","gateBlock":"{\"escalate\":true,\"worker\":\"claude-code\",\"confidence\":0.8,\"category\":\"code\",\"brief\":\"fix build\",\"est_scope\":\"small\"}","expected":"Dispatch","note":"CLI path, model escalates"}
{"text":"fix the failing build in the auth endpoint","fromTool":false,"tier":"chat","gateBlock":null,"expected":"Talk","note":"CLI path, no model escalation"}
{"text":"refactor src/lib/server/chat.ts to split the DB helpers","fromTool":false,"tier":"chat","expected":"Dispatch","note":"explicit file path"}
{"text":"update src/lib/server/chat.ts please","fromTool":true,"expected":"Ask","locked":true,"note":"tool-sourced content must be confirmed"}
{"text":"hey how are you today","fromTool":false,"tier":"chat","expected":"Talk","note":"pure chatter"}
{"text":"what do you think about moving to a monorepo?","fromTool":false,"tier":"planning","expected":"Ask","note":"opinion-seeking during planning; check before acting"}
{"text":"let's design the new dashboard layout together","fromTool":false,"tier":"planning","expected":"Talk","note":"brainstorming, not a work order"}
{"text":"should we refactor stream_prepare?","fromTool":false,"tier":"planning","expected":"Ask","note":"borderline — confirm before dispatch"}
{"text":"implement the login screen for the companion","fromTool":false,"tier":"chat","expected":"Dispatch","note":"strong imperative + repo"}
{"text":"please go implement the login screen","fromTool":false,"tier":"chat","expected":"Ask","note":"imperative but vague target — confirm first"}
{"text":"can you investigate why the orb animation stutters","fromTool":false,"tier":"chat","expected":"Ask","note":"investigation request — confirm scope"}
{"text":"migrate the legacy /api/chat route to sdk-stream","fromTool":false,"tier":"chat","expected":"Dispatch","note":"strong imperative + code target"}
{"text":"thanks, that's perfect","fromTool":false,"tier":"chat","expected":"Talk","note":"acknowledgement"}
{"text":"i'm thinking about how the voice mode should feel","fromTool":false,"tier":"planning","expected":"Talk","note":"brainstorm; 'thinking about' deny phrase"}
{"text":"create a new endpoint for thread export in the console","fromTool":false,"tier":"chat","expected":"Dispatch","note":"strong imperative + repo + code"}
{"text":"remove the dead Canvas persistence code","fromTool":false,"tier":"chat","expected":"Dispatch","note":"strong imperative + code keyword"}
{"text":"figure out what's slow about the build","fromTool":false,"tier":"chat","expected":"Ask","note":"'figure out' deny phrase — confirm before work"}
{"text":"the build fails on the auth endpoint, can you fix it","fromTool":false,"tier":"chat","expected":"Dispatch","note":"code keyword + imperative"}
{"text":"what's the weather like for you in there","fromTool":false,"tier":"chat","expected":"Talk","note":"chatter"}
{"text":"add error handling to companionDispatch.ts","fromTool":false,"tier":"chat","expected":"Dispatch","note":"file path"}
{"text":"i wonder if we should use a different model for voice","fromTool":false,"tier":"planning","expected":"Talk","note":"'wonder' — brainstorm"}
{"text":"debug the stale-job issue in dispatchJobs.ts","fromTool":false,"tier":"chat","expected":"Dispatch","note":"file path + debug"}
{"text":"walk me through how the decision gate works","fromTool":false,"tier":"planning","expected":"Talk","note":"explanation request"}
{"text":"write a migration to add a workspaces table","fromTool":false,"tier":"chat","expected":"Dispatch","note":"strong imperative + code keyword (migration)"}
{"text":"update the readme","fromTool":false,"tier":"chat","expected":"Ask","note":"soft imperative, vague target — confirm"}
{"text":"that one looks good, ship it","fromTool":false,"tier":"chat","expected":"Talk","note":"approval, not a new task"}
{"text":"compare the two approaches for me","fromTool":false,"tier":"planning","expected":"Talk","note":"comparison/brainstorm"}
{"text":"fix the type error in turn_replay.ts","fromTool":false,"tier":"chat","expected":"Dispatch","note":"file path"}
{"text":"i think the dispatch is too trigger-happy","fromTool":false,"tier":"chat","expected":"Talk","note":"feedback, not a work order"}
{"text":"@cc run the test suite and report failures","fromTool":false,"expected":"Dispatch","note":"explicit @cc"}
{"text":"how should we structure the workspace folders","fromTool":false,"tier":"planning","expected":"Talk","note":"'how should we' planning phrase"}
{"text":"build the project scaffolder for project workspaces","fromTool":false,"tier":"chat","expected":"Ask","note":"soft imperative 'build' + no concrete code target — confirm"}
{"text":"create the routing scorecard test file","fromTool":false,"tier":"chat","expected":"Dispatch","note":"strong imperative + code keyword (test)"}
{"text":"good morning sully","fromTool":false,"tier":"chat","expected":"Talk","note":"greeting"}
{"text":"investigate the empty thread_id bug and fix it in activity/+server.ts","fromTool":false,"tier":"chat","expected":"Dispatch","note":"file path present"}
```

- [ ] **Step 5: Run it — expect PASS**

Run: `npm test -- tests/routing-fixtures.test.ts`
Expected: PASS (≥40 cases, ≥4 locked).

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/routing-cases.jsonl src/lib/server/routing/fixtures.ts tests/routing-fixtures.test.ts
git commit -m "feat(routing): labeled fixture corpus + loader"
```

---

### Task 9: Scorecard module (scoring + confusion matrix + report)

**Files:**

- Create: `src/lib/server/routing/scorecard.ts`
- Test: `tests/routing-scorecard-module.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/routing-scorecard-module.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { scoreCases, renderReport } from '$lib/server/routing/scorecard';
import type { RoutingCase } from '$lib/server/routing/fixtures';

const CASES: RoutingCase[] = [
	{ text: '@cc fix build', fromTool: false, expected: 'Dispatch', locked: true },
	{ text: 'hey there', fromTool: false, expected: 'Talk' },
	{ text: 'update src/foo.ts', fromTool: true, expected: 'Ask' }
];

describe('scoreCases', () => {
	it('computes accuracy, per-class precision/recall, confusion matrix, and misses', () => {
		const r = scoreCases(CASES);
		expect(r.total).toBe(3);
		expect(r.accuracy).toBeGreaterThan(0);
		expect(
			r.confusion.Dispatch.Dispatch + r.confusion.Talk.Talk + r.confusion.Ask.Ask
		).toBeLessThanOrEqual(3);
		expect(Array.isArray(r.misses)).toBe(true);
		expect(r.lockedFailures).toBeDefined();
	});
	it('renders a non-empty markdown report', () => {
		expect(renderReport(scoreCases(CASES))).toContain('Confusion matrix');
	});
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- tests/routing-scorecard-module.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/lib/server/routing/scorecard.ts`**

```typescript
// Pure scorecard over a labeled RoutingCase set. Runs each case through the
// production decide() and tallies accuracy, per-class precision/recall, a 3x3
// confusion matrix, the exact misses, and any LOCKED-case failures (the hard
// regression set). No I/O — renderReport returns a markdown string the caller
// may write to disk.
import { decide, type RouteAction } from './decide';
import type { RoutingCase } from './fixtures';

const CLASSES: RouteAction[] = ['Talk', 'Ask', 'Dispatch'];

export interface Miss {
	text: string;
	expected: RouteAction;
	got: RouteAction;
	reason: string;
	locked: boolean;
}

export interface Scorecard {
	total: number;
	correct: number;
	accuracy: number; // 0..1
	confusion: Record<RouteAction, Record<RouteAction, number>>;
	precision: Record<RouteAction, number>;
	recall: Record<RouteAction, number>;
	misses: Miss[];
	lockedFailures: Miss[];
}

function emptyConfusion(): Record<RouteAction, Record<RouteAction, number>> {
	const m = {} as Record<RouteAction, Record<RouteAction, number>>;
	for (const a of CLASSES) {
		m[a] = {} as Record<RouteAction, number>;
		for (const b of CLASSES) m[a][b] = 0;
	}
	return m;
}

export function scoreCases(cases: RoutingCase[]): Scorecard {
	const confusion = emptyConfusion();
	const misses: Miss[] = [];
	let correct = 0;

	for (const c of cases) {
		const d = decide({
			userText: c.text,
			fromTool: c.fromTool,
			recentTier: c.tier,
			gateBlock: c.gateBlock
		});
		confusion[c.expected][d.action] += 1;
		if (d.action === c.expected) correct += 1;
		else
			misses.push({
				text: c.text,
				expected: c.expected,
				got: d.action,
				reason: d.reason,
				locked: !!c.locked
			});
	}

	const precision = {} as Record<RouteAction, number>;
	const recall = {} as Record<RouteAction, number>;
	for (const cls of CLASSES) {
		const tp = confusion[cls][cls];
		const predicted = CLASSES.reduce((s, a) => s + confusion[a][cls], 0); // column sum
		const actual = CLASSES.reduce((s, b) => s + confusion[cls][b], 0); // row sum
		precision[cls] = predicted ? tp / predicted : 1;
		recall[cls] = actual ? tp / actual : 1;
	}

	return {
		total: cases.length,
		correct,
		accuracy: cases.length ? correct / cases.length : 1,
		confusion,
		precision,
		recall,
		misses,
		lockedFailures: misses.filter((m) => m.locked)
	};
}

export function renderReport(s: Scorecard): string {
	const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
	const lines: string[] = [];
	lines.push('# Sully Routing Scorecard');
	lines.push('');
	lines.push(`**Accuracy:** ${pct(s.accuracy)} (${s.correct}/${s.total})`);
	lines.push('');
	lines.push('| Class | Precision | Recall |');
	lines.push('| --- | --- | --- |');
	for (const cls of CLASSES)
		lines.push(`| ${cls} | ${pct(s.precision[cls])} | ${pct(s.recall[cls])} |`);
	lines.push('');
	lines.push('## Confusion matrix (rows = expected, cols = got)');
	lines.push('');
	lines.push(`| expected ↓ \\ got → | ${CLASSES.join(' | ')} |`);
	lines.push(`| --- | ${CLASSES.map(() => '---').join(' | ')} |`);
	for (const e of CLASSES)
		lines.push(`| ${e} | ${CLASSES.map((g) => s.confusion[e][g]).join(' | ')} |`);
	lines.push('');
	lines.push(`## Misses (${s.misses.length})`);
	lines.push('');
	for (const m of s.misses) {
		lines.push(
			`- ${m.locked ? '🔒 ' : ''}\`${m.text}\` — expected **${m.expected}**, got **${m.got}** (${m.reason})`
		);
	}
	return lines.join('\n');
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm test -- tests/routing-scorecard-module.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/lib/server/routing/scorecard.ts tests/routing-scorecard-module.test.ts
git commit -m "feat(routing): pure scorecard module (accuracy, P/R, confusion, misses)"
```

---

### Task 10: The hard CI gate + `routing:score` + baseline threshold

**Files:**

- Create: `src/lib/server/routing/threshold.ts` (committed threshold constant)
- Create: `tests/routing-scorecard.test.ts` (the gate; runs in CI via `npm test`)
- Modify: `package.json` (add `routing:score` script)
- Test: itself

- [ ] **Step 1: Create the threshold constant (provisional)**

Create `src/lib/server/routing/threshold.ts`:

```typescript
// The committed routing-accuracy floor enforced by the CI gate. Set to the
// observed green baseline; raised (never silently lowered) as the gate improves.
// Updated in Tasks 10/11/12 with the measured number.
export const ROUTING_ACCURACY_THRESHOLD = 0.0;
```

- [ ] **Step 2: Create the gate test `tests/routing-scorecard.test.ts`**

```typescript
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadRoutingCases } from '$lib/server/routing/fixtures';
import { scoreCases, renderReport } from '$lib/server/routing/scorecard';
import { ROUTING_ACCURACY_THRESHOLD } from '$lib/server/routing/threshold';

describe('routing scorecard — HARD CI GATE', () => {
	const score = scoreCases(loadRoutingCases());

	// Always print the headline so even CI logs show the numbers.
	// eslint-disable-next-line no-console
	console.log(
		`[routing-scorecard] accuracy ${(score.accuracy * 100).toFixed(1)}% (${score.correct}/${score.total}); misses ${score.misses.length}`
	);

	// Human report written only when explicitly requested (npm run routing:score),
	// so the plain CI `npm test` run stays side-effect-free.
	if (process.env.ROUTING_SCORE_REPORT === '1') {
		const dir = path.resolve(process.cwd(), 'data/peer_reviews');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'routing-scorecard-latest.md'), renderReport(score));
	}

	it('no locked regression case fails', () => {
		expect(score.lockedFailures, JSON.stringify(score.lockedFailures, null, 2)).toHaveLength(0);
	});

	it(`overall accuracy ≥ committed threshold (${ROUTING_ACCURACY_THRESHOLD})`, () => {
		expect(score.accuracy).toBeGreaterThanOrEqual(ROUTING_ACCURACY_THRESHOLD);
	});
});
```

- [ ] **Step 3: Add the `routing:score` script to `package.json`**

In the `scripts` block, add:

```json
		"routing:score": "ROUTING_SCORE_REPORT=1 vitest run tests/routing-scorecard.test.ts"
```

- [ ] **Step 4: Run the scorecard to get the baseline**

Run: `npm run routing:score`
Read the `[routing-scorecard] accuracy XX.X%` line AND open `data/peer_reviews/routing-scorecard-latest.md`. Note: at this point the tier-suppression + regex fixes are NOT in, so brainstorm/Ask cases will mostly be misses — that's expected. Record the accuracy (e.g. say it prints 62.0%).

> **If `lockedFailures` is non-empty here:** the locked cases that depend on the Task 11/12 fixes (`wire up the companion`, the brainstorm line, `update the kernel news`) will fail because those fixes aren't in yet. To keep the gate honest and green per-commit, temporarily REMOVE `"locked":true` from those three brainstorm-suppression cases in the JSONL now, and RE-ADD it in Task 11 Step 5 once the fix makes them pass. The `@cc` and tool-sourced locked cases already pass.

- [ ] **Step 5: Set the threshold to the measured baseline**

Edit `src/lib/server/routing/threshold.ts` — set `ROUTING_ACCURACY_THRESHOLD` to the observed baseline rounded DOWN to the nearest 0.01 (e.g. measured 0.62 → `0.62`).

- [ ] **Step 6: Run the gate — expect PASS**

Run: `npm test -- tests/routing-scorecard.test.ts`
Expected: PASS (locked cases green; accuracy ≥ threshold).

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/routing/threshold.ts tests/routing-scorecard.test.ts package.json tests/fixtures/routing-cases.jsonl
git commit -m "feat(routing): hard CI gate + routing:score report + baseline threshold"
```

---

### Task 11: Safe fix A — suppress autonomous dispatch during brainstorm/planning

**Why:** `classifyTier` detects planning/deep but `decide()` ignores it. Suppressing autonomous (non-@cc) fire in those tiers would have caught the real journal false-positive.

**Files:**

- Modify: `src/lib/server/routing/decide.ts`
- Test: `tests/routing-decide.test.ts` (extend) + re-score

- [ ] **Step 1: Write the failing test (append to `tests/routing-decide.test.ts`)**

```typescript
describe('decide — tier suppression (safe fix A)', () => {
	it('a qualifying request during planning becomes Ask, not Dispatch', () => {
		const d = decide({
			userText: 'add a settings page to the console',
			fromTool: false,
			recentTier: 'planning'
		});
		expect(d.action).toBe('Ask');
	});
	it('@cc still dispatches even during planning', () => {
		const d = decide({
			userText: '@cc add a settings page to the console',
			fromTool: false,
			recentTier: 'planning'
		});
		expect(d.action).toBe('Dispatch');
	});
	it('chat tier is unaffected (still dispatches)', () => {
		const d = decide({
			userText: 'add a settings page to the console',
			fromTool: false,
			recentTier: 'chat'
		});
		expect(d.action).toBe('Dispatch');
	});
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- tests/routing-decide.test.ts`
Expected: FAIL — planning case currently returns `Dispatch`.

- [ ] **Step 3: Add the tier rule to `decide()`**

In `src/lib/server/routing/decide.ts`, immediately AFTER the `vg.forceAsk` check (step 3) and BEFORE the model-vote step, insert:

```typescript
// Safe fix A: never AUTONOMOUSLY fire mid-brainstorm. A qualifying request
// while the thread is in planning/deep is a likely "talking about it", not a
// work order — surface it as Ask (Phase 2 will turn this into a real prompt;
// today the caller maps Ask → do-not-fire). @cc already short-circuited above.
if (input.recentTier === 'planning' || input.recentTier === 'deep') {
	return { action: 'Ask', reason: 'qualifies-but-brainstorm-tier' };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm test -- tests/routing-decide.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-lock the brainstorm cases + re-score**

Re-add `"locked":true` to the three brainstorm cases in `tests/fixtures/routing-cases.jsonl` that were unlocked in Task 10 Step 4 (the journal line, `wire up the companion`, `update the kernel news`).

Run: `npm run routing:score`
Expected: accuracy is HIGHER than the Task 10 baseline; the planning/Ask cases now correct. Record the new number.

- [ ] **Step 6: Raise the threshold**

Edit `src/lib/server/routing/threshold.ts` to the new baseline (rounded down to 0.01).

- [ ] **Step 7: Gate + full suite green, then commit**

Run: `npm run check && npm test`
Expected: all pass, including the scorecard gate.

```bash
git add src/lib/server/routing/decide.ts src/lib/server/routing/threshold.ts tests/routing-decide.test.ts tests/fixtures/routing-cases.jsonl
git commit -m "feat(routing): safe fix A — suppress autonomous dispatch during planning/deep"
```

---

### Task 12: Safe fix B — tighten the valueGate false-positive surface

**Why:** Soft imperatives + a bare repo word ("wire up the companion", "update the kernel news") wrongly qualify; brainstorm phrases ("trying to", "thinking about", "figure out") should not.

**Files:**

- Modify: `src/lib/server/decisionGate.ts:22-78`
- Test: `tests/decision-gate.test.ts` (extend) + re-score

- [ ] **Step 1: Write the failing tests (append to `tests/decision-gate.test.ts`'s `valueGate` describe)**

```typescript
it('does NOT qualify a soft imperative + bare repo ("wire up the companion")', () => {
	expect(valueGate({ text: 'wire up the companion', fromTool: false }).qualifies).toBe(false);
});
it('does NOT qualify "update the kernel news" (soft imperative + repo word)', () => {
	expect(valueGate({ text: 'update the kernel news', fromTool: false }).qualifies).toBe(false);
});
it('STILL qualifies a soft imperative when a file path is present', () => {
	expect(valueGate({ text: 'update src/lib/server/chat.ts', fromTool: false }).qualifies).toBe(
		true
	);
});
it('does NOT qualify a brainstorm phrase ("trying to figure out the build")', () => {
	expect(
		valueGate({ text: 'trying to figure out the build in the console', fromTool: false }).qualifies
	).toBe(false);
});
it('STILL qualifies a strong imperative + repo ("add a settings page to the console")', () => {
	expect(valueGate({ text: 'add a settings page to the console', fromTool: false }).qualifies).toBe(
		true
	);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- tests/decision-gate.test.ts`
Expected: FAIL — the soft-imperative + brainstorm cases currently qualify.

- [ ] **Step 3: Tighten `valueGate` in `decisionGate.ts`**

Replace `IMPERATIVE_RE` (lines 30-31) and the qualification logic in `valueGate` (lines 59-77). New regexes (after `REPO_RE`):

```typescript
// Strong imperatives clearly name a work action with a target.
const STRONG_IMPERATIVE_RE =
	/\b(fix|add|implement|refactor|create|remove|migrate|debug|investigate|write)\b/i;
// Soft imperatives double as everyday verbs ("update the news", "build a
// relationship", "wire up X") — they require a CODE/FILE target, not a bare repo.
const SOFT_IMPERATIVE_RE = /\b(update|build|wire)\b/i;
// Brainstorm/uncertainty phrasing — talking ABOUT work, not ordering it.
const BRAINSTORM_DENY_RE =
	/\b(trying to|thinking about|think about|figure out|figuring out|not sure|wondering|wonder if|brainstorm|talk through|walk me through|what do you think|how should we)\b/i;
```

New `valueGate` body:

```typescript
export function valueGate(input: { text: string; fromTool: boolean }): ValueGateResult {
	const text = (input.text || '').trim();
	const hasFile = FILE_PATH_RE.test(text);
	const hasCode = CODE_KEYWORD_RE.test(text);
	const hasRepo = REPO_RE.test(text);
	const hasStrong = STRONG_IMPERATIVE_RE.test(text);
	const hasSoft = SOFT_IMPERATIVE_RE.test(text);
	const isBrainstorm = BRAINSTORM_DENY_RE.test(text);

	// A file path is a strong signal on its own — even a brainstorm phrase can't
	// veto an explicit path. Otherwise a brainstorm phrasing blocks qualification.
	const strongTarget = hasStrong && (hasRepo || hasCode);
	const softTarget = hasSoft && (hasFile || hasCode); // soft verbs need a CODE/FILE target
	const qualifies = hasFile || (!isBrainstorm && (strongTarget || softTarget));

	const reason = !qualifies
		? isBrainstorm && !hasFile
			? 'brainstorm-deny'
			: 'no-objective-signal'
		: hasFile
			? 'file-path-signal'
			: hasRepo
				? 'imperative+repo'
				: 'imperative+code';
	return { qualifies, forceAsk: input.fromTool === true, reason };
}
```

(Delete the now-unused `IMPERATIVE_RE`.)

- [ ] **Step 4: Run the gate tests — expect PASS**

Run: `npm test -- tests/decision-gate.test.ts`
Expected: PASS — both the original cases (still green) and the 5 new ones.

- [ ] **Step 5: Re-score + raise threshold**

Run: `npm run routing:score`
Expected: accuracy higher again (the soft-imperative false-positives now Talk). Record it. Edit `threshold.ts` to the new baseline (rounded down to 0.01).

- [ ] **Step 6: Full suite green, then commit**

Run: `npm run check && npm test`
Expected: all pass.

```bash
git add src/lib/server/decisionGate.ts src/lib/server/routing/threshold.ts tests/decision-gate.test.ts
git commit -m "feat(routing): safe fix B — tighten valueGate (soft-imperative + brainstorm deny)"
```

---

### Task 13: Capture the SULLY_GATE model-vote blocks for later offline scoring

**Why:** The model-vote layer can't be scored offline without samples. Start capturing real teacher gate blocks now (free); scoring is deferred.

**Files:**

- Create: `src/lib/server/routing/captureGate.ts`
- Modify: `src/lib/server/chat/autonomous_dispatch.ts` (capture when a gate block is present)
- Test: `tests/routing-capture.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/routing-capture.test.ts`:

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { captureGateBlock } from '$lib/server/routing/captureGate';

const FILE = '/tmp/sully-gate-capture-test.jsonl';
afterEach(() => {
	if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
});

describe('captureGateBlock', () => {
	it('appends one JSON line per captured block', () => {
		captureGateBlock(
			{ userText: 'fix the build', gateBlock: '{"escalate":true}', tier: 'chat' },
			FILE
		);
		captureGateBlock({ userText: 'just chatting', gateBlock: null, tier: 'chat' }, FILE);
		const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n');
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).userText).toBe('fix the build');
	});
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- tests/routing-capture.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/lib/server/routing/captureGate.ts`**

```typescript
// Append-only capture of the teacher's SULLY_GATE self-assessment blocks, so the
// model-vote layer can be scored OFFLINE later without a live model. Best-effort,
// never throws into the turn pipeline. Disabled unless ROUTING_CAPTURE_GATES=1.
import fs from 'node:fs';
import path from 'node:path';

export interface GateCapture {
	userText: string;
	gateBlock: string | null;
	tier?: string;
}

export function captureGateBlock(
	c: GateCapture,
	file = path.resolve(process.cwd(), 'data/routing-gate-blocks.jsonl')
): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, JSON.stringify({ ...c, at: new Date().toISOString() }) + '\n');
	} catch (e) {
		console.warn('[captureGate] skipped:', e);
	}
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm test -- tests/routing-capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire capture into `maybeAutonomousDispatch` (CLI path only)**

In `src/lib/server/chat/autonomous_dispatch.ts`, import and call it when a gate block is present (env-gated):

```typescript
import { captureGateBlock } from '$lib/server/routing/captureGate';
```

After computing `const gate = ...` (the brief/category line), add:

```typescript
if (args.gateBlock !== undefined && env.ROUTING_CAPTURE_GATES === '1') {
	captureGateBlock({ userText, gateBlock: args.gateBlock ?? null, tier: args.tier });
}
```

(Import `env`: `import { env } from '$env/dynamic/private';` — already the env source used across server modules.)

- [ ] **Step 6: Type-check + full suite, then commit**

Run: `npm run check && npm test`
Expected: all pass.

```bash
git add src/lib/server/routing/captureGate.ts src/lib/server/chat/autonomous_dispatch.ts tests/routing-capture.test.ts
git commit -m "feat(routing): capture SULLY_GATE model-vote blocks for later offline scoring"
```

---

### Task 14: Verify the hard CI gate end-to-end + finalize

**Files:**

- Modify: `.github/workflows/ci.yml` (explicit scorecard step name for visibility)

- [ ] **Step 1: Prove the gate FAILS on a forced regression**

Temporarily edit `tests/fixtures/routing-cases.jsonl`: flip one locked case's `expected` to a wrong value (e.g. the `@cc fix build` case → `"expected":"Talk"`).

Run: `npm test -- tests/routing-scorecard.test.ts`
Expected: FAIL (`lockedFailures` non-empty). Revert the edit; re-run → PASS.

- [ ] **Step 2: Add an explicit CI step (visibility only — `npm test` already runs it)**

In `.github/workflows/ci.yml`, after the "Unit tests (vitest)" step, append:

```yaml
- name: Routing scorecard (hard gate)
  run: npm test -- tests/routing-scorecard.test.ts
```

(This is redundant with `npm test` but surfaces the routing gate as its own named check — useful for branch-protection required-status visibility.)

- [ ] **Step 3: Full green run**

Run: `npm run check && npm test`
Expected: 0 type errors; ALL tests pass including the scorecard gate.

- [ ] **Step 4: Commit + push + PR**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(routing): surface the routing scorecard as a named hard gate"
git push -u origin feat/routing-scorecard-phase0-1
gh pr create --fill --title "Routing scorecard + close-the-loops (Phase 0 + Phase 1)"
```

- [ ] **Step 5: Return to main clean (operator rule)**

```bash
git checkout main
git status   # must be clean; do NOT sweep the pre-existing not-ours working-tree changes
```

---

## Self-review notes (author)

- **Spec coverage:** Phase 0 fixes 0.1–0.6 → Tasks 2,2,3,1,4,5. Phase 1 decide()/fixtures/report/gate → Tasks 6–10. Safe fixes A/B → Tasks 11–12. Model-vote capture → Task 13. Hard CI gate (operator decision) → Tasks 10 + 14. Labeling-as-QLoRA-seed → the JSONL corpus IS the labeled seed (DB-column persistence of labels is gap-audit Phase 4, explicitly out of scope here; noted so spec success-criterion "labels persisted" reads as "labels captured in the reviewable corpus").
- **Threshold is data-driven:** set at the measured green baseline in Task 10, ratcheted up in 11/12 — the plan never asserts a number it can't observe at execution time.
- **Locked-case ordering:** Task 10 Step 4 unlocks the three fix-dependent brainstorm cases so each commit stays green; Task 11 Step 5 re-locks them once the fix lands. This keeps every commit's gate honest.
- **No real-DB mutation:** every DB test uses `/tmp/sully-*-test.db` + the `$env/dynamic/private` mock pattern from `tests/dispatch-jobs.test.ts`.
