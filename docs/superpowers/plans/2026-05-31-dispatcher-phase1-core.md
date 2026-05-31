# Sully Dispatcher — Phase 1 Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Sully (LogueOS-Companion) a value-gated, brake-protected worker-dispatch capability with a live SSE "Working bubble". Phase 1 covers 1a (unblock dispatch + activity-callback writer into `companion.db`), 1b (`pending_jobs` state machine + decision gate + brakes + actual-token capture), and 1c (SSE transport + resume reconciliation + Working bubble + chips + Autonomy "Ask" control + dispatch meter). Maps to spec §4.1-4.8, §4.11, §5, §6, §8, §10 Phase 1, §12 acceptance 1a/1b/1c.

**Architecture:** SvelteKit (adapter-node) + Svelte 5 runes + TypeScript + better-sqlite3, serving at `:18769` under base path `/companion`. A NEW companion-native config flag (`runMode.companionDispatchEnabled`, distinct from the kernel `_wired` gate) unblocks the existing `+server.ts:206` short-circuit. Dispatch reaches the existing dispatch listener over HMAC (reusing `dispatch-listener.ts` signing). The worker HTTP-calls back to a new authenticated `POST /api/chat/activity` endpoint that writes `chat_activity` rows into `companion.db`. A new `pending_jobs` table drives a `decided → dispatched → working → done|failed|retry|aborted` state machine. A decision gate (rule pre-filter → deterministic value gate + injection guard → CLI-bridge schema self-assessment riding the same Opus reply) decides escalations. Brakes (daily dispatch cap, 429 circuit-breaker, token bucket, content fingerprint, two-level kill switch) bound the loop. The client replaces 5s activity polling with an `EventSource` (id `trace:seq`, 15s heartbeat, resume reconciliation via `visibilitychange` + Capacitor `App` `resume`).

**Tech Stack:** SvelteKit (`@sveltejs/kit`), Svelte 5 runes, TypeScript, `better-sqlite3` (idempotent `CREATE TABLE IF NOT EXISTS` migrations), `node:crypto` HMAC-SHA256, `@capacitor/app` (8.1.0, already a dep). Tests = vitest (`npx vitest run tests/<file>.test.ts`), test files live in `tests/**/*.test.ts` (NOT colocated), env stubbed via `vi.doMock('$env/dynamic/private', ...)` + `vi.stubEnv(...)`. Build + deploy = `npm run build` then `sudo systemctl restart logueos-companion`.

---

## File Structure

| File                                              | Create/Modify | Responsibility                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/server/config.ts`                        | Modify        | Add `companionDispatchEnabled` flag to `runMode` (companion-native, NOT `_wired`), the `companionDispatchCap`, `companionDispatchWindowMin`, `companionCallbackSecret`, `companionCallbackBaseUrl` server config reads. |
| `src/lib/server/dispatchJobs.ts`                  | Create        | `pending_jobs` table + idempotent migration + state-machine writers/readers + actual-token columns, all on `companion.db`.                                                                                              |
| `src/lib/server/chatActivity.ts`                  | Modify        | Add the `writeActivity(traceId, action, target)` writer + `ensureActivityTable()` (the file is read-only today).                                                                                                        |
| `src/lib/server/decisionGate.ts`                  | Create        | Rule pre-filter + deterministic value gate + injection guard + schema parse/validation of `{escalate,worker,confidence,category,brief,est_scope}` from the CLI-bridge reply tail.                                       |
| `src/lib/server/dispatchBrakes.ts`                | Create        | Daily dispatch-count budget, 429 circuit-breaker, token-bucket rate-limiter, content-fingerprint no-re-escalation, two-level kill switch (gate + abort-in-flight).                                                      |
| `src/lib/server/companionDispatch.ts`             | Create        | Orchestrates: gate → brakes → HMAC handoff POST to listener → `pending_jobs` lifecycle. Builds the worker prompt with the companion callback URL.                                                                       |
| `src/lib/server/dispatchUsage.ts`                 | Create        | Parse the worker result-marker telemetry into `pending_jobs.actual_*` columns; capture the meter (dispatch count + wall-clock today).                                                                                   |
| `src/routes/api/chat/+server.ts`                  | Modify        | Replace the `:206` companion short-circuit: when `companionDispatchEnabled`, route through `companionDispatch`.                                                                                                         |
| `src/routes/api/chat/activity/+server.ts`         | Modify        | Re-gate behind `companionDispatchEnabled`; add `POST` worker-callback (HMAC-authed) that calls `writeActivity` + reads result-marker telemetry into `pending_jobs`.                                                     |
| `src/routes/api/chat/dispatch/stream/+server.ts`  | Create        | SSE endpoint: `id: trace:seq` per row, response-init headers, ~15s heartbeat, replays `seq > Last-Event-ID` from `pending_jobs`/`chat_activity`.                                                                        |
| `src/routes/api/chat/dispatch/[trace]/+server.ts` | Create        | GET a single `pending_jobs` row for resume reconciliation.                                                                                                                                                              |
| `src/routes/api/chat/dispatch/meter/+server.ts`   | Create        | GET the companion dispatch meter (count + wall-clock today).                                                                                                                                                            |
| `src/lib/chat/dispatchStream.svelte.ts`           | Create        | Client `EventSource` controller: open via `resolve()`, reconnect-on-resume reconciliation (`visibilitychange` + Capacitor `App` `resume`), dedupe by seq.                                                               |
| `src/routes/chat/+page.svelte`                    | Modify        | Replace `pollActivity` 5s loop with the SSE controller; render the Working bubble + inline approve/skip/edit chips.                                                                                                     |
| `src/lib/components/DispatchChips.svelte`         | Create        | Inline "Sully wants to send this to CC — [brief]" → [Approve]·[Skip]·[Edit brief] chip row.                                                                                                                             |
| `src/lib/components/WorkingBubble.svelte`         | Create        | Working bubble: live rows + elapsed timer; collapses on `done`; bounded retry on `failed`/`aborted`.                                                                                                                    |
| `src/routes/settings/+page.svelte`                | Create        | Settings page with the Autonomy segmented control (Ask · Auto-for-safe · Full-auto) + dispatch meter readout.                                                                                                           |
| `tests/dispatch-config.test.ts`                   | Create        | Asserts `companionDispatchEnabled` is OFF by default, ON only when the explicit flag is set; never aliased to `_wired`.                                                                                                 |
| `tests/dispatch-jobs.test.ts`                     | Create        | State-machine transitions + actual-token column writes on a temp DB.                                                                                                                                                    |
| `tests/decision-gate.test.ts`                     | Create        | Rule pre-filter, value gate, injection guard, schema parse/validation incl. the empirical schema-emission test.                                                                                                         |
| `tests/dispatch-brakes.test.ts`                   | Create        | Daily cap, 429 breaker (no-retry), token bucket, fingerprint, kill-switch abort.                                                                                                                                        |
| `tests/dispatch-usage.test.ts`                    | Create        | Result-marker telemetry → `actual_*` columns; agy → predicted-only.                                                                                                                                                     |
| `tests/dispatch-stream.test.ts`                   | Create        | SSE id format `trace:seq`, headers, heartbeat shape, Last-Event-ID replay selection.                                                                                                                                    |

---

## Tasks

### Task 1a.1 — Companion-native dispatch config flag

**Files:** modify `src/lib/server/config.ts`; create `tests/dispatch-config.test.ts`

The flag MUST be companion-native: ON only in companion mode AND only when `COMPANION_DISPATCH_ENABLED=true`. It must NOT reuse `_wired` (which is the kernel-coupling gate; reusing it would re-enable kernel gateway dispatch). Builds on `config.ts:143-153` (the `runMode` object) and `config.ts:21-22` (`getEnv`).

- [ ] Write the failing test `tests/dispatch-config.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadRunMode(env: Record<string, string>) {
	vi.resetModules();
	for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
	vi.doMock('$env/dynamic/private', () => ({ env }));
	const { runMode } = await import('$lib/server/config');
	return runMode;
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.doUnmock('$env/dynamic/private');
});

describe('companionDispatchEnabled', () => {
	it('is OFF by default in companion mode (flag unset)', async () => {
		const rm = await loadRunMode({ LOGUEOS_APP_MODE: 'companion' });
		expect(rm.companionDispatchEnabled).toBe(false);
	});

	it('is ON in companion mode when COMPANION_DISPATCH_ENABLED=true', async () => {
		const rm = await loadRunMode({
			LOGUEOS_APP_MODE: 'companion',
			COMPANION_DISPATCH_ENABLED: 'true'
		});
		expect(rm.companionDispatchEnabled).toBe(true);
	});

	it('stays OFF in wired mode even with the flag set (companion-only feature)', async () => {
		const rm = await loadRunMode({
			LOGUEOS_APP_MODE: 'wired',
			COMPANION_DISPATCH_ENABLED: 'true'
		});
		expect(rm.companionDispatchEnabled).toBe(false);
	});

	it('is NOT aliased to the kernel _wired gate', async () => {
		const rm = await loadRunMode({
			LOGUEOS_APP_MODE: 'companion',
			COMPANION_DISPATCH_ENABLED: 'true'
		});
		// kernel dispatch (gateway) must remain OFF in companion mode
		expect(rm.dispatchEnabled).toBe(false);
		expect(rm.kernelWired).toBe(false);
		expect(rm.companionDispatchEnabled).toBe(true);
	});
});
```

- [ ] Run it (expect FAIL — `companionDispatchEnabled` is undefined):

```bash
npx vitest run tests/dispatch-config.test.ts
```

- [ ] Add the server-config reads. In `src/lib/server/config.ts`, inside the `serverConfig` object, after the `orchestratorEnvPath` entry (`config.ts:131-134`), insert:

```ts
	,
	// ── Companion dispatcher (Phase 1) ──────────────────────────────────────
	// Companion-native dispatch is gated by its OWN flag, NOT the kernel `_wired`
	// gate. `_wired`/`dispatchEnabled` stay false in companion mode (they govern
	// the kernel GATEWAY path); this flag governs the NEW companion->listener path.
	companionDispatchCap: parsePositiveInt(
		getEnv('COMPANION_DISPATCH_CAP', '20'),
		'COMPANION_DISPATCH_CAP'
	),
	companionDispatchWindowMin: parsePositiveInt(
		getEnv('COMPANION_DISPATCH_WINDOW_MIN', '1440'),
		'COMPANION_DISPATCH_WINDOW_MIN'
	),
	// Shared secret the dispatched worker uses to authenticate its activity
	// callback POST to /api/chat/activity (HMAC over the raw body). Empty =
	// callback auth disabled (callbacks rejected) — fail closed.
	companionCallbackSecret: getEnv('COMPANION_CALLBACK_SECRET', ''),
	// Absolute base URL the worker prompt embeds so the worker can reach this
	// app's callback endpoint (e.g. the :8444 tailnet origin).
	companionCallbackBaseUrl: getEnv(
		'COMPANION_CALLBACK_BASE_URL',
		'https://room.taila28611.ts.net:8444/companion'
	)
```

- [ ] Add the derived boolean. In `src/lib/server/config.ts`, modify the `runMode` object (`config.ts:144-153`) to add the new flag and a private companion-dispatch derivation just above it:

```ts
const _companionDispatch =
	serverConfig.mode === 'companion' && getEnv('COMPANION_DISPATCH_ENABLED', 'false') === 'true';
export const runMode = {
	mode: serverConfig.mode,
	companion: !_wired,
	kernelWired: _wired, // master gate
	dispatchEnabled: _wired, // @cc/@agy + workflow gateway dispatch (KERNEL path)
	observationsEnabled: _wired, // Tier-0 observation emit to the shared DB
	gatewayWorkspaces: _wired, // fetch workspace list from the gateway
	completionPoller: _wired, // tail cc_completion_log.jsonl for push
	killSwitchEnabled: _wired, // read the system_halt kernel artifact
	companionDispatchEnabled: _companionDispatch // NEW companion->listener dispatch
} as const;
```

- [ ] Run it (expect PASS):

```bash
npx vitest run tests/dispatch-config.test.ts
```

- [ ] Commit:

```bash
git add src/lib/server/config.ts tests/dispatch-config.test.ts && git commit -m "feat(dispatch): add companion-native dispatch config flag

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1a.2 — `chat_activity` writer + table ensure

**Files:** modify `src/lib/server/chatActivity.ts`; create `tests/dispatch-jobs.test.ts` (shared helper file — first half here)

`chatActivity.ts` opens the DB readonly today (`chatActivity.ts:13-15`). The worker can't reach `companion.db` directly, so the companion must write the rows. Match the kernel `chat_activity` schema exactly (verified `init_memory_db.py:113`): `(id INTEGER PK AUTOINCREMENT, trace_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP)`.

- [ ] Write the failing test `tests/dispatch-jobs.test.ts` (activity-writer portion):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-dispatch-jobs-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close(); // create empty file so existsSync passes
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

describe('writeActivity', () => {
	it('creates the table on first write and reads back by trace_id', async () => {
		const { writeActivity } = await import('$lib/server/chatActivity');
		const { getActivityForTrace } = await import('$lib/server/chatActivity');
		writeActivity('sully-1', 'reading', 'src/foo.ts');
		writeActivity('sully-1', 'edited', 'src/foo.ts');
		const rows = getActivityForTrace('sully-1');
		expect(rows.map((r) => r.action)).toEqual(['reading', 'edited']);
		expect(rows[0].target).toBe('src/foo.ts');
	});

	it('accepts a null target (e.g. thinking/completed)', async () => {
		const { writeActivity, getActivityForTrace } = await import('$lib/server/chatActivity');
		writeActivity('sully-2', 'thinking', null);
		expect(getActivityForTrace('sully-2')[0].target).toBeNull();
	});
});
```

- [ ] Run it (expect FAIL — `writeActivity` not exported):

```bash
npx vitest run tests/dispatch-jobs.test.ts
```

- [ ] Implement the writer. In `src/lib/server/chatActivity.ts`, add after the imports (after `chatActivity.ts:3`):

```ts
let _activityEnsured = false;
function ensureActivityTable(db: Database.Database): void {
	if (_activityEnsured) return;
	db.exec(`
		CREATE TABLE IF NOT EXISTS chat_activity (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			trace_id TEXT NOT NULL,
			action TEXT NOT NULL,
			target TEXT,
			timestamp TEXT DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_chat_activity_trace ON chat_activity(trace_id, timestamp);
	`);
	_activityEnsured = true;
}

/**
 * Write a single activity row into companion.db. The dispatched worker can't
 * reach the DB directly, so it HTTP-calls POST /api/chat/activity which calls
 * this. (The kernel emit_chat_activity.py writes logueos_memory.db, the wrong DB
 * for the companion.) action ∈ {reading,edited,ran,thinking,completed,failed}.
 */
export function writeActivity(traceId: string, action: string, target: string | null): void {
	if (!traceId || !action) return;
	const db = new Database(serverConfig.memoryDbPath);
	try {
		ensureActivityTable(db);
		db.prepare('INSERT INTO chat_activity (trace_id, action, target) VALUES (?, ?, ?)').run(
			traceId,
			action,
			target ?? null
		);
	} finally {
		db.close();
	}
}
```

- [ ] Run it (expect PASS):

```bash
npx vitest run tests/dispatch-jobs.test.ts
```

- [ ] Commit:

```bash
git add src/lib/server/chatActivity.ts tests/dispatch-jobs.test.ts && git commit -m "feat(dispatch): add chat_activity writer into companion.db

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1b.1 — `pending_jobs` table + state machine

**Files:** create `src/lib/server/dispatchJobs.ts`; extend `tests/dispatch-jobs.test.ts`

Schema per spec §4.4 with the §4.11 actual-token columns: `{ id, trace_id, worker, status, category, current_activity, seq_cursor, started_at, ended_at, predicted_tokens, actual_prompt, actual_completion, actual_cache_read, actual_cache_creation, actual_total, result_ref, brief, fingerprint }`. States: `decided → dispatched → working → done|failed|retry|aborted`. Migration is idempotent like `usage.ts:37-50`. `predicted_tokens` is telemetry-only (never a brake input).

- [ ] Add the failing test (append to `tests/dispatch-jobs.test.ts`):

```ts
describe('pending_jobs state machine', () => {
	it('creates a decided job, advances through working to done', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.createJob({
			traceId: 'sully-10',
			worker: 'claude-code',
			category: 'code',
			brief: 'fix the build',
			fingerprint: 'abc',
			predictedTokens: 0
		});
		expect(j.getJob('sully-10')?.status).toBe('decided');
		j.markDispatched('sully-10');
		expect(j.getJob('sully-10')?.status).toBe('dispatched');
		j.markWorking('sully-10', 'reading src/foo.ts');
		expect(j.getJob('sully-10')?.status).toBe('working');
		expect(j.getJob('sully-10')?.current_activity).toBe('reading src/foo.ts');
		j.markDone('sully-10', 'artifact://ref-1');
		const done = j.getJob('sully-10');
		expect(done?.status).toBe('done');
		expect(done?.result_ref).toBe('artifact://ref-1');
		expect(done?.ended_at).not.toBeNull();
	});

	it('rejects an illegal transition (done -> working)', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.createJob({
			traceId: 'sully-11',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'd',
			predictedTokens: 0
		});
		j.markDone('sully-11', null);
		expect(() => j.markWorking('sully-11', 'late')).toThrow(/illegal transition/i);
	});

	it('lists in-flight jobs (decided/dispatched/working) for kill-switch abort', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.createJob({
			traceId: 'sully-12',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'e',
			predictedTokens: 0
		});
		j.markWorking('sully-12', 'editing');
		const inflight = j.listInFlight();
		expect(inflight.map((r) => r.trace_id)).toContain('sully-12');
	});
});
```

- [ ] Run it (expect FAIL — module missing):

```bash
npx vitest run tests/dispatch-jobs.test.ts
```

- [ ] Create `src/lib/server/dispatchJobs.ts`:

```ts
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

export type JobStatus =
	| 'decided'
	| 'dispatched'
	| 'working'
	| 'done'
	| 'failed'
	| 'retry'
	| 'aborted';

export interface PendingJob {
	id: number;
	trace_id: string;
	worker: string;
	status: JobStatus;
	category: string;
	current_activity: string | null;
	seq_cursor: number;
	started_at: string | null;
	ended_at: string | null;
	predicted_tokens: number;
	actual_prompt: number | null;
	actual_completion: number | null;
	actual_cache_read: number | null;
	actual_cache_creation: number | null;
	actual_total: number | null;
	result_ref: string | null;
	brief: string;
	fingerprint: string;
}

// Allowed forward transitions. decided -> dispatched -> working -> terminal;
// retry loops back to dispatched. Terminal states accept no further moves.
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
	decided: ['dispatched', 'aborted', 'failed'],
	dispatched: ['working', 'done', 'failed', 'retry', 'aborted'],
	working: ['done', 'failed', 'retry', 'aborted'],
	retry: ['dispatched', 'aborted', 'failed'],
	done: [],
	failed: [],
	aborted: []
};

let _ensured = false;
function getDb(): Database.Database {
	const db = new Database(serverConfig.memoryDbPath);
	if (!_ensured) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS pending_jobs (
				id                    INTEGER PRIMARY KEY AUTOINCREMENT,
				trace_id              TEXT UNIQUE NOT NULL,
				worker                TEXT NOT NULL,
				status                TEXT NOT NULL DEFAULT 'decided',
				category              TEXT NOT NULL DEFAULT 'general',
				current_activity      TEXT,
				seq_cursor            INTEGER NOT NULL DEFAULT 0,
				started_at            TEXT DEFAULT CURRENT_TIMESTAMP,
				ended_at              TEXT,
				predicted_tokens      INTEGER NOT NULL DEFAULT 0,
				actual_prompt         INTEGER,
				actual_completion     INTEGER,
				actual_cache_read     INTEGER,
				actual_cache_creation INTEGER,
				actual_total          INTEGER,
				result_ref            TEXT,
				brief                 TEXT NOT NULL DEFAULT '',
				fingerprint           TEXT NOT NULL DEFAULT ''
			);
			CREATE INDEX IF NOT EXISTS idx_pending_jobs_status ON pending_jobs(status);
			CREATE INDEX IF NOT EXISTS idx_pending_jobs_fp ON pending_jobs(fingerprint);
		`);
		_ensured = true;
	}
	return db;
}

export function createJob(opts: {
	traceId: string;
	worker: string;
	category: string;
	brief: string;
	fingerprint: string;
	predictedTokens: number;
}): void {
	const db = getDb();
	try {
		db.prepare(
			`INSERT INTO pending_jobs (trace_id, worker, status, category, brief, fingerprint, predicted_tokens)
			 VALUES (?, ?, 'decided', ?, ?, ?, ?)`
		).run(
			opts.traceId,
			opts.worker,
			opts.category,
			opts.brief,
			opts.fingerprint,
			opts.predictedTokens
		);
	} finally {
		db.close();
	}
}

export function getJob(traceId: string): PendingJob | undefined {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return undefined;
	const db = getDb();
	try {
		return db.prepare('SELECT * FROM pending_jobs WHERE trace_id = ?').get(traceId) as
			| PendingJob
			| undefined;
	} finally {
		db.close();
	}
}

function transition(traceId: string, to: JobStatus, patch: Partial<PendingJob> = {}): void {
	const db = getDb();
	try {
		const row = db.prepare('SELECT status FROM pending_jobs WHERE trace_id = ?').get(traceId) as
			| { status: JobStatus }
			| undefined;
		if (!row) throw new Error(`no job for trace_id ${traceId}`);
		if (!TRANSITIONS[row.status].includes(to)) {
			throw new Error(`illegal transition ${row.status} -> ${to} for ${traceId}`);
		}
		const cols = ['status = ?'];
		const vals: unknown[] = [to];
		for (const [k, v] of Object.entries(patch)) {
			cols.push(`${k} = ?`);
			vals.push(v);
		}
		vals.push(traceId);
		db.prepare(`UPDATE pending_jobs SET ${cols.join(', ')} WHERE trace_id = ?`).run(...vals);
	} finally {
		db.close();
	}
}

export function markDispatched(traceId: string): void {
	transition(traceId, 'dispatched');
}
export function markWorking(traceId: string, activity: string | null): void {
	transition(traceId, 'working', { current_activity: activity });
}
export function markDone(traceId: string, resultRef: string | null): void {
	transition(traceId, 'done', { result_ref: resultRef, ended_at: new Date().toISOString() });
}
export function markFailed(traceId: string, reason: string | null): void {
	transition(traceId, 'failed', { current_activity: reason, ended_at: new Date().toISOString() });
}
export function markRetry(traceId: string): void {
	transition(traceId, 'retry');
}
export function markAborted(traceId: string): void {
	transition(traceId, 'aborted', { ended_at: new Date().toISOString() });
}

/** In-flight jobs the kill switch must cancel. */
export function listInFlight(): PendingJob[] {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = getDb();
	try {
		return db
			.prepare(
				`SELECT * FROM pending_jobs WHERE status IN ('decided','dispatched','working','retry')`
			)
			.all() as PendingJob[];
	} finally {
		db.close();
	}
}
```

- [ ] Run it (expect PASS):

```bash
npx vitest run tests/dispatch-jobs.test.ts
```

- [ ] Commit:

```bash
git add src/lib/server/dispatchJobs.ts tests/dispatch-jobs.test.ts && git commit -m "feat(dispatch): pending_jobs table + state machine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1b.2 — Decision gate: rule pre-filter + value gate + injection guard

**Files:** create `src/lib/server/decisionGate.ts`; create `tests/decision-gate.test.ts`

Per spec §4.2 stages 1+2. Rule pre-filter is zero-token (keywords, file paths, literal `@cc`/`@agy`). Value gate blocks dispatch unless an objective signal is present (code/repo/file signal OR length/complexity floor). Injection guard: content flagged `fromTool` (tool output / pasted text) NEVER auto-dispatches — always an Ask-chip, even in Full-auto. Value-gate heuristic pinned here: a "qualifying" message needs a code/repo signal (file-path regex, language keyword, repo name) OR `length >= 280` chars with an imperative verb. The schema self-assessment (stage 3) is a separate task (1b.3).

- [ ] Write the failing test `tests/decision-gate.test.ts` (gate portion):

```ts
import { describe, expect, it } from 'vitest';
import { ruleGate, valueGate } from '$lib/server/decisionGate';

describe('ruleGate', () => {
	it('hard-routes an explicit @cc mention to dispatch', () => {
		expect(ruleGate('@cc fix the failing test')).toEqual({ forced: true, worker: 'claude-code' });
	});
	it('hard-routes @agy to gemini', () => {
		expect(ruleGate('@agy restyle the header')).toEqual({ forced: true, worker: 'gemini' });
	});
	it('returns no forced route for plain chat', () => {
		expect(ruleGate('what do you think about dinner')).toEqual({ forced: false });
	});
});

describe('valueGate', () => {
	it('blocks a trivial conversational message', () => {
		expect(valueGate({ text: 'hey how are you', fromTool: false }).qualifies).toBe(false);
	});
	it('passes a message with a file path signal', () => {
		expect(
			valueGate({ text: 'update src/lib/server/chat.ts please', fromTool: false }).qualifies
		).toBe(true);
	});
	it('passes a long imperative message above the complexity floor', () => {
		const long =
			'refactor ' +
			'the entire authentication flow including session handling and token refresh '.repeat(4);
		expect(valueGate({ text: long, fromTool: false }).qualifies).toBe(true);
	});
	it('injection guard: tool-sourced content NEVER auto-qualifies (forces ask)', () => {
		const r = valueGate({ text: 'update src/lib/server/chat.ts please', fromTool: true });
		expect(r.qualifies).toBe(true);
		expect(r.forceAsk).toBe(true);
	});
});
```

- [ ] Run it (expect FAIL — module missing):

```bash
npx vitest run tests/decision-gate.test.ts
```

- [ ] Create `src/lib/server/decisionGate.ts` (stages 1+2 only; stage 3 added next task):

```ts
// Decision Gate (spec §4.2). Three stages, no second local model:
//   1. ruleGate       — zero-token literal pre-filter (@cc/@agy mentions).
//   2. valueGate      — deterministic, model-independent objective-signal gate
//                       + injection guard (tool/pasted content can't auto-fire).
//   3. parseSchema    — validate the {escalate,...} tail of the CLI-bridge reply
//                       (Task 1b.3).

export interface RuleResult {
	forced: boolean;
	worker?: 'claude-code' | 'gemini';
}

// Literal worker mentions force a dispatch route, bypassing the value gate.
export function ruleGate(text: string): RuleResult {
	const t = text.toLowerCase();
	if (t.includes('@cc')) return { forced: true, worker: 'claude-code' };
	if (t.includes('@agy') || t.includes('@gemini')) return { forced: true, worker: 'gemini' };
	return { forced: false };
}

// Objective signals that justify spending a cloud dispatch.
const FILE_PATH_RE = /\b[\w./-]+\.(ts|tsx|js|svelte|py|json|md|css|sql|sh|yaml|yml)\b/;
const CODE_KEYWORD_RE =
	/\b(function|class|import|export|refactor|bug|stack ?trace|compile|build fails?|test fails?|migration|endpoint|component|deploy)\b/i;
const REPO_RE = /\b(miru|orchestrator|kernel|console|nasdoom|companion)\b/i;
const IMPERATIVE_RE =
	/\b(fix|add|build|implement|refactor|create|update|remove|migrate|wire|debug|investigate|write)\b/i;

// Pinned value-gate heuristic: a qualifying message has a code/repo/file signal,
// OR is a long (>=280 char) imperative request. Tunable later from telemetry.
const COMPLEXITY_FLOOR_CHARS = 280;

export interface ValueGateResult {
	qualifies: boolean;
	/** True when the content is tool-sourced/pasted — must Ask even in Full-auto. */
	forceAsk: boolean;
	reason: string;
}

export function valueGate(input: { text: string; fromTool: boolean }): ValueGateResult {
	const text = (input.text || '').trim();
	const hasFile = FILE_PATH_RE.test(text);
	const hasCode = CODE_KEYWORD_RE.test(text);
	const hasRepo = REPO_RE.test(text);
	const longImperative = text.length >= COMPLEXITY_FLOOR_CHARS && IMPERATIVE_RE.test(text);
	const qualifies = hasFile || hasCode || hasRepo || longImperative;
	const reason = qualifies
		? hasFile
			? 'file-path-signal'
			: hasCode
				? 'code-keyword'
				: hasRepo
					? 'repo-signal'
					: 'long-imperative'
		: 'no-objective-signal';
	// Injection guard: never auto-dispatch tool/pasted content.
	return { qualifies, forceAsk: input.fromTool === true, reason };
}
```

- [ ] Run it (expect PASS):

```bash
npx vitest run tests/decision-gate.test.ts
```

- [ ] Commit:

```bash
git add src/lib/server/decisionGate.ts tests/decision-gate.test.ts && git commit -m "feat(dispatch): decision gate rule pre-filter + value gate + injection guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1b.3 — Decision gate: schema self-assessment parse + validation (the schema-emission test)

**Files:** modify `src/lib/server/decisionGate.ts`; extend `tests/decision-gate.test.ts`

Per spec §4.2 stage 3 + §12-1b "the schema-emission test passes". The schema rides the SAME CLI-bridge Opus reply (`claude_cli_stream.ts streamViaClaudeCLI` — verified: it yields `text-delta` chunks then one `finish`). The model is instructed to append a fenced `<<<SULLY_GATE ... >>>` block as the tail of its reply; the server strips it from the visible reply and validates it. `est_scope` ∈ {`small`,`medium`,`large`}. `confidence` ∈ [0,1]. `worker` ∈ {`claude-code`,`gemini`}. `category` is a free short string. The empirical test feeds a realistic raw reply string (mirroring what `streamViaClaudeCLI` would assemble) and asserts the parser extracts + validates it and strips it from the user-visible text.

- [ ] Add the failing test (append to `tests/decision-gate.test.ts`):

```ts
import { GATE_INSTRUCTION, extractGateBlock, validateGate } from '$lib/server/decisionGate';

describe('schema self-assessment (rides the CLI-bridge reply)', () => {
	it('GATE_INSTRUCTION documents the exact marker the model must emit', () => {
		expect(GATE_INSTRUCTION).toContain('<<<SULLY_GATE');
		expect(GATE_INSTRUCTION).toContain('>>>');
		expect(GATE_INSTRUCTION).toContain('escalate');
		expect(GATE_INSTRUCTION).toContain('est_scope');
	});

	it('extracts + validates a well-formed gate block and strips it from the visible reply', () => {
		const raw =
			'Sure, I can hand that to a worker.\n\n' +
			'<<<SULLY_GATE {"escalate":true,"worker":"claude-code","confidence":0.82,"category":"code","brief":"fix failing build in src/foo.ts","est_scope":"small"} >>>';
		const { visible, block } = extractGateBlock(raw);
		expect(visible).toBe('Sure, I can hand that to a worker.');
		const v = validateGate(block);
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.gate.escalate).toBe(true);
			expect(v.gate.worker).toBe('claude-code');
			expect(v.gate.est_scope).toBe('small');
			expect(v.gate.confidence).toBeCloseTo(0.82);
		}
	});

	it('no gate block -> treated as no-escalation, full text stays visible', () => {
		const { visible, block } = extractGateBlock('Just chatting, no need for a worker.');
		expect(visible).toBe('Just chatting, no need for a worker.');
		expect(block).toBeNull();
	});

	it('rejects an invalid worker value (server-side validation = correctness, not a brake)', () => {
		const v = validateGate(
			'{"escalate":true,"worker":"rogue","confidence":0.9,"category":"x","brief":"y","est_scope":"small"}'
		);
		expect(v.ok).toBe(false);
	});

	it('rejects an out-of-range confidence', () => {
		const v = validateGate(
			'{"escalate":true,"worker":"gemini","confidence":1.7,"category":"x","brief":"y","est_scope":"large"}'
		);
		expect(v.ok).toBe(false);
	});

	it('clamps a malformed block to no-escalation rather than throwing', () => {
		const v = validateGate('not json at all');
		expect(v.ok).toBe(false);
	});
});
```

- [ ] Run it (expect FAIL — symbols not exported):

```bash
npx vitest run tests/decision-gate.test.ts
```

- [ ] Append to `src/lib/server/decisionGate.ts`:

```ts
// ── Stage 3: schema self-assessment (rides the same CLI-bridge Opus reply) ──
// The teacher (cloud Opus via claude_cli_stream.ts) is told to APPEND a single
// machine-readable block as the LAST line of its reply. We strip it from the
// visible text and validate it server-side. Zero extra model, zero extra call.

export const GATE_INSTRUCTION = `
DISPATCH SELF-ASSESSMENT — after your normal reply, if (and only if) the request
would be better executed by a coding worker than answered directly, append ONE
line in EXACTLY this shape as the final line of your message (otherwise omit it):

<<<SULLY_GATE {"escalate":true,"worker":"claude-code","confidence":0.0,"category":"<short>","brief":"<one-line task brief>","est_scope":"small|medium|large"} >>>

worker MUST be "claude-code" (backend/code) or "gemini" (frontend/UI). confidence
is 0..1. Do NOT wrap it in code fences. Emit nothing if no dispatch is warranted.
`.trim();

export interface GateSchema {
	escalate: boolean;
	worker: 'claude-code' | 'gemini';
	confidence: number;
	category: string;
	brief: string;
	est_scope: 'small' | 'medium' | 'large';
}

const GATE_RE = /<<<SULLY_GATE\s*([\s\S]*?)\s*>>>/;

/** Split a raw assembled reply into the operator-visible text + the gate JSON. */
export function extractGateBlock(raw: string): { visible: string; block: string | null } {
	const m = raw.match(GATE_RE);
	if (!m) return { visible: raw.trim(), block: null };
	const visible = raw.replace(GATE_RE, '').trim();
	return { visible, block: m[1].trim() };
}

export type GateValidation = { ok: true; gate: GateSchema } | { ok: false; error: string };

export function validateGate(block: string | null): GateValidation {
	if (!block) return { ok: false, error: 'no-gate-block' };
	let parsed: unknown;
	try {
		parsed = JSON.parse(block);
	} catch {
		return { ok: false, error: 'malformed-json' };
	}
	const g = parsed as Partial<GateSchema>;
	if (typeof g.escalate !== 'boolean') return { ok: false, error: 'escalate-not-boolean' };
	if (g.worker !== 'claude-code' && g.worker !== 'gemini')
		return { ok: false, error: 'invalid-worker' };
	if (typeof g.confidence !== 'number' || g.confidence < 0 || g.confidence > 1)
		return { ok: false, error: 'confidence-out-of-range' };
	if (typeof g.category !== 'string' || !g.category.trim())
		return { ok: false, error: 'missing-category' };
	if (typeof g.brief !== 'string' || !g.brief.trim()) return { ok: false, error: 'missing-brief' };
	if (g.est_scope !== 'small' && g.est_scope !== 'medium' && g.est_scope !== 'large')
		return { ok: false, error: 'invalid-est-scope' };
	return {
		ok: true,
		gate: {
			escalate: g.escalate,
			worker: g.worker,
			confidence: g.confidence,
			category: g.category.trim(),
			brief: g.brief.trim(),
			est_scope: g.est_scope
		}
	};
}
```

- [ ] Run it (expect PASS):

```bash
npx vitest run tests/decision-gate.test.ts
```

- [ ] Commit:

```bash
git add src/lib/server/decisionGate.ts tests/decision-gate.test.ts && git commit -m "feat(dispatch): schema self-assessment parse + validation (gate-emission test)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1b.4 — Brakes: daily cap, 429 circuit-breaker, token bucket, fingerprint, kill switch

**Files:** create `src/lib/server/dispatchBrakes.ts`; create `tests/dispatch-brakes.test.ts`

Per spec §4.11. Pinned defaults: retry default = 2 (consumed in 1b.5), daily dispatch cap default = `serverConfig.companionDispatchCap` (20), rolling window default = `companionDispatchWindowMin` (1440 min). Brakes:

1. **Daily dispatch-count budget** — count `pending_jobs` started in the window; HARD stop at cap.
2. **429 circuit-breaker** — once tripped, halt-all + cooldown, NEVER retry on 429.
3. **Token-bucket rate-limiter** — refill-rate gate before the handoff POST.
4. **Content fingerprint** — `sha256(brief|category|target_repo)`; refuse a re-escalation of the same fingerprint within a per-conversation cap.
5. **Two-level kill switch** — gate new AND abort in-flight (the abort wiring lives in 1b.6; here we provide the state + `isKilled()`).

- [ ] Write the failing test `tests/dispatch-brakes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-dispatch-brakes-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	COMPANION_DISPATCH_CAP: '2',
	COMPANION_DISPATCH_WINDOW_MIN: '1440',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
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

describe('fingerprint', () => {
	it('hashes brief|category|target_repo stably', async () => {
		const { fingerprintFor } = await import('$lib/server/dispatchBrakes');
		const a = fingerprintFor('fix build', 'code', 'companion');
		const b = fingerprintFor('fix build', 'code', 'companion');
		expect(a).toBe(b);
		expect(a).not.toBe(fingerprintFor('fix build', 'code', 'miru'));
	});
});

describe('daily cap', () => {
	it('allows up to the cap then HARD-stops', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { checkDailyCap } = await import('$lib/server/dispatchBrakes');
		expect(checkDailyCap().allowed).toBe(true);
		j.createJob({
			traceId: 's1',
			worker: 'claude-code',
			category: 'code',
			brief: 'a',
			fingerprint: 'f1',
			predictedTokens: 0
		});
		j.createJob({
			traceId: 's2',
			worker: 'claude-code',
			category: 'code',
			brief: 'b',
			fingerprint: 'f2',
			predictedTokens: 0
		});
		expect(checkDailyCap().allowed).toBe(false); // cap=2 reached
	});
});

describe('429 circuit breaker', () => {
	it('trips, halts all, and never permits a retry while open', async () => {
		const cb = await import('$lib/server/dispatchBrakes');
		expect(cb.breakerOpen()).toBe(false);
		cb.trip429();
		expect(cb.breakerOpen()).toBe(true);
		expect(cb.canRetryAfter(429)).toBe(false);
	});
	it('permits bounded retry for transient (non-429) errors', async () => {
		const cb = await import('$lib/server/dispatchBrakes');
		expect(cb.canRetryAfter(503)).toBe(true);
	});
});

describe('token bucket', () => {
	it('drains then refuses until refill', async () => {
		const { TokenBucket } = await import('$lib/server/dispatchBrakes');
		const tb = new TokenBucket(2, 0); // capacity 2, no refill
		expect(tb.take()).toBe(true);
		expect(tb.take()).toBe(true);
		expect(tb.take()).toBe(false);
	});
});

describe('fingerprint re-escalation guard', () => {
	it('refuses the same fingerprint twice within the conversation cap', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { fingerprintFor, checkFingerprint } = await import('$lib/server/dispatchBrakes');
		const fp = fingerprintFor('fix build', 'code', 'companion');
		expect(checkFingerprint(fp).allowed).toBe(true);
		j.createJob({
			traceId: 's9',
			worker: 'claude-code',
			category: 'code',
			brief: 'fix build',
			fingerprint: fp,
			predictedTokens: 0
		});
		expect(checkFingerprint(fp).allowed).toBe(false);
	});
});
```

- [ ] Run it (expect FAIL — module missing):

```bash
npx vitest run tests/dispatch-brakes.test.ts
```

- [ ] Create `src/lib/server/dispatchBrakes.ts`:

```ts
// Cost/quota brakes (spec §4.11). All countable signals; no billed API-key path.
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

// Default bounded-retry count for TRANSIENT errors only (never 429). Pinned = 2.
export const DEFAULT_RETRIES = 2;
// Max re-uses of one content fingerprint per conversation before refusal.
const FINGERPRINT_CAP = 1;

export function fingerprintFor(brief: string, category: string, targetRepo: string): string {
	return crypto
		.createHash('sha256')
		.update(`${brief}|${category}|${targetRepo}`)
		.digest('hex')
		.slice(0, 16);
}

// ── Daily dispatch-count budget (rolling window) ────────────────────────────
export function checkDailyCap(): { allowed: boolean; used: number; cap: number } {
	const cap = serverConfig.companionDispatchCap;
	if (!fs.existsSync(serverConfig.memoryDbPath)) return { allowed: true, used: 0, cap };
	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		const cutoff = new Date(
			Date.now() - serverConfig.companionDispatchWindowMin * 60 * 1000
		).toISOString();
		const row = db
			.prepare('SELECT COUNT(*) AS n FROM pending_jobs WHERE started_at >= ?')
			.get(cutoff) as { n: number };
		return { allowed: row.n < cap, used: row.n, cap };
	} catch {
		return { allowed: true, used: 0, cap }; // table not created yet
	} finally {
		db.close();
	}
}

// ── 429 circuit breaker (module-level state; resets after cooldown) ─────────
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;
let _breakerTrippedAt = 0;
export function trip429(): void {
	_breakerTrippedAt = Date.now();
}
export function breakerOpen(): boolean {
	if (_breakerTrippedAt === 0) return false;
	if (Date.now() - _breakerTrippedAt > BREAKER_COOLDOWN_MS) {
		_breakerTrippedAt = 0;
		return false;
	}
	return true;
}
/** Never retry a 429; bounded retry is for transient (non-429) failures only. */
export function canRetryAfter(statusCode: number): boolean {
	return statusCode !== 429;
}

// ── Token-bucket rate limiter (before the handoff POST) ─────────────────────
export class TokenBucket {
	private tokens: number;
	private last = Date.now();
	constructor(
		private capacity: number,
		private refillPerSec: number
	) {
		this.tokens = capacity;
	}
	take(): boolean {
		const now = Date.now();
		this.tokens = Math.min(
			this.capacity,
			this.tokens + ((now - this.last) / 1000) * this.refillPerSec
		);
		this.last = now;
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}
		return false;
	}
}
// One shared bucket: 5 dispatches burst, refill 1 / 30s.
export const dispatchBucket = new TokenBucket(5, 1 / 30);

// ── Content-fingerprint no-re-escalation ────────────────────────────────────
export function checkFingerprint(fp: string): { allowed: boolean } {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return { allowed: true };
	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		const row = db
			.prepare('SELECT COUNT(*) AS n FROM pending_jobs WHERE fingerprint = ?')
			.get(fp) as { n: number };
		return { allowed: row.n <= FINGERPRINT_CAP - 1 };
	} catch {
		return { allowed: true };
	} finally {
		db.close();
	}
}

// ── Two-level kill switch (companion-LOCAL) ─────────────────────────────────
// Level 1: gate new dispatches. Level 2: abort in-flight (wired in
// companionDispatch.killAll). Module-level toggle; reset on restart.
let _killed = false;
export function engageKill(): void {
	_killed = true;
}
export function clearKill(): void {
	_killed = false;
}
export function isKilled(): boolean {
	return _killed;
}
```

- [ ] Run it (expect PASS):

```bash
npx vitest run tests/dispatch-brakes.test.ts
```

- [ ] Commit:

```bash
git add src/lib/server/dispatchBrakes.ts tests/dispatch-brakes.test.ts && git commit -m "feat(dispatch): brakes (daily cap, 429 breaker, token bucket, fingerprint, kill)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1b.5 — Actual-token capture from the worker result-marker

**Files:** create `src/lib/server/dispatchUsage.ts`; create `tests/dispatch-usage.test.ts`

Per spec §4.11. The worker's final callback carries its result-marker telemetry (`usage_capture.js` unified shape, verified: `{ worker, model, usage: { prompt, completion, cache_read, cache_creation, total } }`). The companion can't run the listener's usage*capture, so the WORKER posts its usage in the activity callback; this module writes it into `pending_jobs.actual*\*`. agy has no actuals (binary protobuf) → `usage: null` → leave actual columns NULL (predicted-only).

- [ ] Write the failing test `tests/dispatch-usage.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-dispatch-usage-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
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

describe('captureActualTokens', () => {
	it('writes the unified marker usage into pending_jobs.actual_* columns', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { captureActualTokens } = await import('$lib/server/dispatchUsage');
		j.createJob({
			traceId: 's1',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0
		});
		captureActualTokens('s1', {
			worker: 'claude-code',
			model: 'claude-sonnet-4-6',
			usage: { prompt: 100, completion: 50, cache_read: 200, cache_creation: 10, total: 360 }
		});
		const row = j.getJob('s1')!;
		expect(row.actual_prompt).toBe(100);
		expect(row.actual_completion).toBe(50);
		expect(row.actual_cache_read).toBe(200);
		expect(row.actual_cache_creation).toBe(10);
		expect(row.actual_total).toBe(360);
	});

	it('agy marker with null usage leaves actual columns NULL (predicted-only)', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { captureActualTokens } = await import('$lib/server/dispatchUsage');
		j.createJob({
			traceId: 's2',
			worker: 'gemini',
			category: 'ui',
			brief: 'x',
			fingerprint: 'g',
			predictedTokens: 0
		});
		captureActualTokens('s2', { worker: 'agy', model: 'gemini', usage: null });
		const row = j.getJob('s2')!;
		expect(row.actual_total).toBeNull();
	});
});

describe('getMeter', () => {
	it('reports dispatch count + wall-clock-seconds today', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { getMeter } = await import('$lib/server/dispatchUsage');
		j.createJob({
			traceId: 's3',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'h',
			predictedTokens: 0
		});
		j.markDispatched('s3');
		j.markWorking('s3', 'editing');
		j.markDone('s3', null);
		const m = getMeter();
		expect(m.count).toBeGreaterThanOrEqual(1);
		expect(m.wallClockSeconds).toBeGreaterThanOrEqual(0);
	});
});
```

- [ ] Run it (expect FAIL — module missing):

```bash
npx vitest run tests/dispatch-usage.test.ts
```

- [ ] Create `src/lib/server/dispatchUsage.ts`:

```ts
// Actual-token capture (spec §4.11). The dispatched worker posts its result-
// marker telemetry (usage_capture.js unified shape) in the final callback; we
// write it into pending_jobs.actual_*. agy has no actuals -> usage:null ->
// columns stay NULL (predicted-only). Also exposes the Phase-1 dispatch meter
// (count + wall-clock today) — countable + honest, no predicted-cost guesswork.
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

export interface MarkerUsage {
	prompt: number;
	completion: number;
	cache_read: number;
	cache_creation: number;
	total: number;
}
export interface ResultMarker {
	worker: string;
	model: string;
	usage: MarkerUsage | null;
}

export function captureActualTokens(traceId: string, marker: ResultMarker): void {
	if (!marker || !marker.usage) return; // agy / failed-before-first-call: leave NULL
	const u = marker.usage;
	const db = new Database(serverConfig.memoryDbPath);
	try {
		db.prepare(
			`UPDATE pending_jobs
			 SET actual_prompt = ?, actual_completion = ?, actual_cache_read = ?,
			     actual_cache_creation = ?, actual_total = ?
			 WHERE trace_id = ?`
		).run(u.prompt, u.completion, u.cache_read, u.cache_creation, u.total, traceId);
	} finally {
		db.close();
	}
}

export interface DispatchMeter {
	count: number;
	wallClockSeconds: number;
}

/** Today's dispatch count + summed wall-clock (started_at..ended_at) seconds. */
export function getMeter(): DispatchMeter {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return { count: 0, wallClockSeconds: 0 };
	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		const today = new Date().toISOString().slice(0, 10);
		const row = db
			.prepare(
				`SELECT COUNT(*) AS count,
				        COALESCE(SUM(
				          CASE WHEN ended_at IS NOT NULL
				               THEN (julianday(ended_at) - julianday(started_at)) * 86400
				               ELSE 0 END
				        ), 0) AS secs
				 FROM pending_jobs
				 WHERE substr(started_at, 1, 10) = ?`
			)
			.get(today) as { count: number; secs: number };
		return { count: row.count, wallClockSeconds: Math.round(row.secs) };
	} catch {
		return { count: 0, wallClockSeconds: 0 };
	} finally {
		db.close();
	}
}
```

- [ ] Run it (expect PASS):

```bash
npx vitest run tests/dispatch-usage.test.ts
```

- [ ] Commit:

```bash
git add src/lib/server/dispatchUsage.ts tests/dispatch-usage.test.ts && git commit -m "feat(dispatch): actual-token capture from worker result-marker + meter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1a.3 — HMAC handoff orchestrator + kill-all wiring

**Files:** create `src/lib/server/companionDispatch.ts`; create `tests/companion-dispatch.test.ts`

Per spec §4.3 + §5 + §6 + §4.11 kill switch. Orchestrates gate-passed escalation: brake checks → `createJob` (`decided`) → HMAC handoff POST to the listener (reusing the `dispatch-listener.ts` `X-W4-HMAC` sha256-hex contract, verified `dispatch-listener.ts:31-32`) → `markDispatched`. `killAll()` iterates `listInFlight()`, POSTs the listener `/kill` per trace (reusing `killWorker`), then `markAborted`. Worker prompt embeds the companion callback URL + secret so the worker posts activity + the final result-marker back. Trace ids use the `sully-<n>` synthetic namespace (regex-conforming for the kernel `ticket_id` inference; spec §4.10). The handoff body shape `{ task, scope, target_repo, brief, trace_id }` per §4.3.

- [ ] Write the failing test `tests/companion-dispatch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-companion-dispatch-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	COMPANION_DISPATCH_ENABLED: 'true',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	COMPANION_DISPATCH_CAP: '20',
	COMPANION_DISPATCH_WINDOW_MIN: '1440',
	COMPANION_CALLBACK_SECRET: 'cbsecret',
	COMPANION_CALLBACK_BASE_URL: 'https://room.example.ts.net:8444/companion',
	LOGUEOS_DISPATCH_LISTENER_URL: 'http://127.0.0.1:19100',
	W4_LISTENER_HMAC_SECRET: 'listenersecret',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	vi.unstubAllGlobals();
});

describe('dispatchToWorker', () => {
	it('creates a decided job, signs the handoff with HMAC, and marks dispatched on 200', async () => {
		let captured: { url: string; body: string; sig: string } | null = null;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				captured = {
					url: String(url),
					body: String(init.body),
					sig: (init.headers as Record<string, string>)['X-W4-HMAC']
				};
				return new Response(JSON.stringify({ ok: true, trace_id: 'sully-1' }), { status: 200 });
			})
		);
		const { dispatchToWorker } = await import('$lib/server/companionDispatch');
		const j = await import('$lib/server/dispatchJobs');
		const res = await dispatchToWorker({
			traceId: 'sully-1',
			worker: 'claude-code',
			category: 'code',
			brief: 'fix the build',
			targetRepo: 'companion',
			task: 'fix the build',
			threadId: 'default'
		});
		expect(res.ok).toBe(true);
		expect(captured!.url).toContain('/dispatch');
		expect(captured!.sig).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
		expect(j.getJob('sully-1')?.status).toBe('dispatched');
	});

	it('refuses when the kill switch is engaged (gate level)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 200 }))
		);
		const brakes = await import('$lib/server/dispatchBrakes');
		brakes.engageKill();
		const { dispatchToWorker } = await import('$lib/server/companionDispatch');
		const res = await dispatchToWorker({
			traceId: 'sully-2',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			targetRepo: 'companion',
			task: 'x',
			threadId: 'default'
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/kill/i);
	});
});

describe('killAll', () => {
	it('aborts in-flight jobs and POSTs the listener /kill for each', async () => {
		const kills: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				if (String(url).endsWith('/kill')) kills.push(String(init.body));
				return new Response(JSON.stringify({ ok: true, killed_pid: 1, released_slot: null }), {
					status: 200
				});
			})
		);
		const j = await import('$lib/server/dispatchJobs');
		j.createJob({
			traceId: 'sully-9',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'z',
			predictedTokens: 0
		});
		j.markWorking('sully-9', 'editing');
		const { killAll } = await import('$lib/server/companionDispatch');
		await killAll();
		expect(j.getJob('sully-9')?.status).toBe('aborted');
		expect(kills.some((b) => b.includes('sully-9'))).toBe(true);
	});
});
```

- [ ] Run it (expect FAIL — module missing):

```bash
npx vitest run tests/companion-dispatch.test.ts
```

- [ ] Create `src/lib/server/companionDispatch.ts`:

```ts
// Companion dispatch orchestrator (spec §4.3, §5, §6). gate -> brakes ->
// createJob(decided) -> HMAC handoff POST to the dispatch listener -> dispatched.
// Reuses dispatch-listener.ts's HMAC contract (sha256 hex in X-W4-HMAC).
import crypto from 'node:crypto';
import { serverConfig } from './config';
import * as jobs from './dispatchJobs';
import {
	fingerprintFor,
	checkDailyCap,
	checkFingerprint,
	breakerOpen,
	dispatchBucket,
	isKilled
} from './dispatchBrakes';
import { killWorker } from './dispatch-listener';

export interface DispatchInput {
	traceId: string;
	worker: 'claude-code' | 'gemini';
	category: string;
	brief: string;
	targetRepo: string;
	task: string;
	threadId: string;
}
export interface DispatchResult {
	ok: boolean;
	reason?: string;
}

function signBody(rawBody: string, secret: string): string {
	return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// The worker prompt that carries the companion callback URL + the activity
// vocabulary + the result-marker contract. The worker posts activity rows and
// (on close) its result-marker telemetry to POST <base>/api/chat/activity.
function buildWorkerPrompt(input: DispatchInput): string {
	const cbUrl = `${serverConfig.companionCallbackBaseUrl.replace(/\/+$/, '')}/api/chat/activity`;
	return `You are a background worker dispatched by Sully (the operator's companion app).
TASK: ${input.task}
TARGET REPO: ${input.targetRepo}
BRIEF: ${input.brief}

PROGRESS CALLBACK — POST each step to ${cbUrl} as JSON:
  { "trace_id": "${input.traceId}", "action": "reading|edited|ran|thinking", "target": "<path or cmd>" }
sign the raw JSON body with HMAC-SHA256 (hex) in the X-Companion-HMAC header using
the shared secret in your COMPANION_CALLBACK_SECRET env var.

CLOSING — POST a terminal row, then your result-marker telemetry:
  { "trace_id": "${input.traceId}", "action": "completed", "result_ref": "<final message or artifact ref>",
    "marker": { "worker": "claude-code", "model": "<model>", "usage": { "prompt": 0, "completion": 0, "cache_read": 0, "cache_creation": 0, "total": 0 } } }
On failure POST action "failed" with target set to a one-line reason.`;
}

export async function dispatchToWorker(input: DispatchInput): Promise<DispatchResult> {
	if (isKilled()) return { ok: false, reason: 'kill switch engaged' };
	if (breakerOpen()) return { ok: false, reason: '429 circuit breaker open' };
	const cap = checkDailyCap();
	if (!cap.allowed)
		return { ok: false, reason: `daily dispatch cap reached (${cap.used}/${cap.cap})` };
	const fp = fingerprintFor(input.brief, input.category, input.targetRepo);
	if (!checkFingerprint(fp).allowed) return { ok: false, reason: 'duplicate dispatch fingerprint' };
	if (!dispatchBucket.take()) return { ok: false, reason: 'rate limited' };

	jobs.createJob({
		traceId: input.traceId,
		worker: input.worker,
		category: input.category,
		brief: input.brief,
		fingerprint: fp,
		predictedTokens: 0
	});

	const secret = serverConfig.dispatchListenerHmacSecret;
	if (!secret) {
		jobs.markFailed(input.traceId, 'listener HMAC secret not configured');
		return { ok: false, reason: 'listener HMAC secret not configured' };
	}
	const url = `${serverConfig.dispatchListenerUrl.replace(/\/+$/, '')}/dispatch`;
	const body = JSON.stringify({
		task: input.task,
		scope: input.brief,
		target_repo: input.targetRepo,
		brief: input.brief,
		trace_id: input.traceId,
		worker: input.worker,
		prompt: buildWorkerPrompt(input)
	});
	try {
		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-W4-HMAC': signBody(body, secret) },
			body
		});
		if (!resp.ok) {
			jobs.markFailed(input.traceId, `listener HTTP ${resp.status}`);
			return { ok: false, reason: `listener HTTP ${resp.status}` };
		}
		jobs.markDispatched(input.traceId);
		return { ok: true };
	} catch (e) {
		jobs.markFailed(input.traceId, e instanceof Error ? e.message : String(e));
		return { ok: false, reason: 'listener unreachable' };
	}
}

/** Two-level kill: gate is in dispatchBrakes.isKilled(); this aborts in-flight. */
export async function killAll(): Promise<void> {
	for (const job of jobs.listInFlight()) {
		try {
			await killWorker(job.trace_id);
		} catch {
			/* best effort — abort the row regardless */
		}
		try {
			jobs.markAborted(job.trace_id);
		} catch {
			/* already terminal */
		}
	}
}
```

- [ ] Run it (expect PASS):

```bash
npx vitest run tests/companion-dispatch.test.ts
```

- [ ] Commit:

```bash
git add src/lib/server/companionDispatch.ts tests/companion-dispatch.test.ts && git commit -m "feat(dispatch): HMAC handoff orchestrator + kill-all in-flight abort

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1a.4 — Worker activity-callback endpoint (POST /api/chat/activity)

**Files:** modify `src/routes/api/chat/activity/+server.ts`

Per spec §4.5. Re-gate the GET behind `companionDispatchEnabled` (currently `activity/+server.ts:9` returns `[]` when `!kernelWired`). Add a `POST` the worker HTTP-calls to write `chat_activity` rows + advance the job + capture the result-marker on `completed`. Auth: HMAC-SHA256 hex over the raw body in `X-Companion-HMAC` using `serverConfig.companionCallbackSecret` (fail closed when the secret is empty). Builds on `writeActivity` (1a.2), `dispatchJobs` (1b.1), `dispatchUsage` (1b.5), `dispatchBrakes.trip429` (1b.4).

- [ ] Replace the contents of `src/routes/api/chat/activity/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { getActivityForTrace, getRecentActivity, writeActivity } from '$lib/server/chatActivity';
import { runMode, serverConfig } from '$lib/server/config';
import { markWorking, markDone, markFailed, getJob } from '$lib/server/dispatchJobs';
import { captureActualTokens, type ResultMarker } from '$lib/server/dispatchUsage';

export const GET: RequestHandler = async ({ url }) => {
	// Worker-activity feed is available when EITHER the kernel is wired OR the
	// companion-native dispatcher is enabled (Phase 1). Otherwise idle.
	if (!runMode.kernelWired && !runMode.companionDispatchEnabled) {
		return json({ activity: [] });
	}
	try {
		const traceId = url.searchParams.get('trace_id');
		const limitParam = url.searchParams.get('limit');
		const limit = limitParam ? Math.max(1, Math.min(500, Number.parseInt(limitParam, 10))) : 200;
		if (traceId) return json({ activity: getActivityForTrace(traceId, limit) });
		return json({ activity: getRecentActivity(limit) });
	} catch (e: unknown) {
		console.error('GET /api/chat/activity error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};

// POST — the dispatched worker calls back here to stream its activity into
// companion.db (it can't reach the DB directly). HMAC-authed; fail closed.
export const POST: RequestHandler = async ({ request }) => {
	if (!runMode.companionDispatchEnabled) {
		return json({ error: 'dispatch_disabled' }, { status: 404 });
	}
	const secret = serverConfig.companionCallbackSecret;
	const raw = await request.text();
	if (!secret) return json({ error: 'callback_auth_unconfigured' }, { status: 401 });
	const provided = request.headers.get('x-companion-hmac') || '';
	const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
	if (
		provided.length !== expected.length ||
		!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
	) {
		return json({ error: 'hmac_reject' }, { status: 401 });
	}
	let body: {
		trace_id?: string;
		action?: string;
		target?: string | null;
		result_ref?: string | null;
		marker?: ResultMarker;
	};
	try {
		body = JSON.parse(raw);
	} catch {
		return json({ error: 'malformed_json' }, { status: 400 });
	}
	const { trace_id, action } = body;
	if (!trace_id || !action) return json({ error: 'trace_id_and_action_required' }, { status: 400 });
	if (!getJob(trace_id)) return json({ error: 'unknown_trace' }, { status: 404 });

	// Always log the raw activity row for the bubble/SSE.
	writeActivity(trace_id, action, body.target ?? null);

	try {
		if (action === 'completed') {
			if (body.marker) captureActualTokens(trace_id, body.marker);
			markDone(trace_id, body.result_ref ?? null);
		} else if (action === 'failed') {
			markFailed(trace_id, body.target ?? null);
		} else {
			markWorking(trace_id, body.target ? `${action} ${body.target}` : action);
		}
	} catch (e) {
		// Illegal transition (e.g. duplicate completed) — row already logged.
		console.warn('activity callback transition skipped:', e);
	}
	return json({ ok: true });
};
```

- [ ] Run the existing job + activity tests to confirm no regression in the modules this route imports:

```bash
npx vitest run tests/dispatch-jobs.test.ts tests/dispatch-usage.test.ts
```

Expected: PASS (the route imports these modules; this validates the import graph compiles).

- [ ] Type-check the route:

```bash
npm run check 2>&1 | grep -A2 "activity/+server" || echo "no activity route type errors"
```

Expected: no errors referencing `activity/+server.ts`.

- [ ] Commit:

```bash
git add src/routes/api/chat/activity/+server.ts && git commit -m "feat(dispatch): worker activity-callback endpoint (HMAC) writing companion.db

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1b.6 — Wire the gate + dispatch into the chat POST (replace the :206 short-circuit)

**Files:** modify `src/routes/api/chat/+server.ts`

Per spec §5 + §10 Phase 1. Replace the `+server.ts:206-217` companion short-circuit so that when `runMode.companionDispatchEnabled`, an explicit `@cc`/`@agy` dispatch intent routes through `companionDispatch.dispatchToWorker` instead of the friendly "not available" note. The kernel gateway path (`+server.ts:359-543`) stays gated behind `runMode.dispatchEnabled` (still false in companion mode) — we do NOT touch it. Trace id is the synthetic `sully-<epoch>` namespace. Worker resolution reuses the existing `worker` variable computed at `+server.ts:122-128` (maps to `claude-code` / `agy`); convert `agy` → `gemini` per spec §4.3.

- [ ] Modify `src/routes/api/chat/+server.ts`. Add imports after the `buildSystemPrompt` import (`+server.ts:18`):

```ts
import { dispatchToWorker } from '$lib/server/companionDispatch';
```

- [ ] Replace the companion short-circuit block (`+server.ts:206-217`, the `if (shouldTrigger && !runMode.dispatchEnabled) { ... return json({ ok: true }); }`) with:

```ts
// Companion-native dispatch (Phase 1). When enabled, an explicit
// @cc/@agy intent reaches a worker via the dispatch listener (HMAC) and
// the worker streams activity back into companion.db. The KERNEL gateway
// path below (runMode.dispatchEnabled) stays OFF in companion mode.
if (shouldTrigger && !runMode.dispatchEnabled && runMode.companionDispatchEnabled) {
	const traceId = `sully-${Date.now()}`;
	// `worker` was resolved above to 'claude-code' | 'agy' | 'auto'.
	// Spec §4.3: emit 'gemini' (the listener-accepted frontend name).
	const dispatchWorker = worker === 'claude-code' ? 'claude-code' : 'gemini';
	const res = await dispatchToWorker({
		traceId,
		worker: dispatchWorker,
		category: 'code',
		brief: message.trim().slice(0, 200),
		targetRepo,
		task: message.trim(),
		threadId
	});
	if (res.ok) {
		addChatMessage(
			'system',
			`Sully sent this to **${dispatchWorker === 'claude-code' ? 'CC' : 'AGY'}** on **${targetRepo}**. (Trace: ${traceId})`,
			traceId,
			ticket_id || null,
			null,
			'sent',
			threadId
		);
	} else {
		addChatMessage(
			'system',
			`⚠️ Dispatch held: ${res.reason}.`,
			null,
			ticket_id || null,
			null,
			'sent',
			threadId
		);
	}
	return json({ ok: true, trace_id: traceId });
}

// Companion mode WITHOUT the dispatch flag: @cc/@agy is unavailable.
if (shouldTrigger && !runMode.dispatchEnabled) {
	addChatMessage(
		'system',
		'Worker dispatch (@cc / @agy) is a kernel feature and is not available in the Companion — this app talks to your local model. Just ask me directly.',
		null,
		null,
		null,
		'sent',
		threadId
	);
	return json({ ok: true });
}
```

- [ ] Type-check the route:

```bash
npm run check 2>&1 | grep -A2 "api/chat/+server" || echo "no chat route type errors"
```

Expected: no errors referencing `api/chat/+server.ts`.

- [ ] Run the dispatch orchestrator test to confirm the imported surface is unchanged:

```bash
npx vitest run tests/companion-dispatch.test.ts
```

Expected: PASS.

- [ ] Commit:

```bash
git add src/routes/api/chat/+server.ts && git commit -m "feat(dispatch): route @cc/@agy through companion dispatcher when enabled

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1c.1 — SSE stream endpoint (id: trace:seq, headers, heartbeat, replay)

**Files:** create `src/routes/api/chat/dispatch/stream/+server.ts`; create `tests/dispatch-stream.test.ts`

Per spec §4.5 + §12-1c. Greenfield SSE. Each event `id: <trace_id>:<seq>` where seq is the `chat_activity.id`. Headers set on the streamed `Response` init (NOT `setHeaders`): `text/event-stream`, `no-cache, no-transform`, `keep-alive`. ~15s heartbeat (`: ping\n\n`). On connect, replay rows with `seq > Last-Event-ID` from `chat_activity` for the trace. Closes when the job is terminal. The pure helpers (`sseEvent`, `parseLastEventId`) are unit-tested; the route wires them to a `ReadableStream`. Model the `new Response(stream, { headers })` shape on `speak-local/+server.ts:50`.

- [ ] Write the failing test `tests/dispatch-stream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sseEvent, parseLastEventId } from '$lib/server/sseFormat';

describe('sseEvent', () => {
	it('formats id: trace:seq + data per the SSE wire format', () => {
		const out = sseEvent('sully-1', 5, { action: 'reading', target: 'src/a.ts' });
		expect(out).toBe('id: sully-1:5\ndata: {"action":"reading","target":"src/a.ts"}\n\n');
	});
});

describe('parseLastEventId', () => {
	it('extracts the numeric seq from a trace:seq Last-Event-ID', () => {
		expect(parseLastEventId('sully-1:42')).toBe(42);
	});
	it('returns 0 for a missing/garbage header', () => {
		expect(parseLastEventId(null)).toBe(0);
		expect(parseLastEventId('nonsense')).toBe(0);
	});
});
```

- [ ] Run it (expect FAIL — module missing):

```bash
npx vitest run tests/dispatch-stream.test.ts
```

- [ ] Create `src/lib/server/sseFormat.ts` (pure helpers, easy to unit-test):

```ts
// Pure SSE wire-format helpers (spec §4.5). id: <trace_id>:<seq> per row so the
// client can resume with Last-Event-ID and replay seq > cursor.
export function sseEvent(traceId: string, seq: number, data: unknown): string {
	return `id: ${traceId}:${seq}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Parse the numeric seq out of a `trace:seq` Last-Event-ID; 0 when absent. */
export function parseLastEventId(header: string | null): number {
	if (!header) return 0;
	const idx = header.lastIndexOf(':');
	if (idx < 0) return 0;
	const n = Number.parseInt(header.slice(idx + 1), 10);
	return Number.isFinite(n) && n > 0 ? n : 0;
}
```

- [ ] Run it (expect PASS):

```bash
npx vitest run tests/dispatch-stream.test.ts
```

- [ ] Create `src/routes/api/chat/dispatch/stream/+server.ts`:

```ts
import type { RequestHandler } from './$types';
import { runMode, serverConfig } from '$lib/server/config';
import { sseEvent, parseLastEventId } from '$lib/server/sseFormat';
import { getJob } from '$lib/server/dispatchJobs';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const HEARTBEAT_MS = 15_000;
const POLL_MS = 1_000;

export const GET: RequestHandler = async ({ url, request }) => {
	if (!runMode.companionDispatchEnabled) {
		return new Response('dispatch disabled', { status: 404 });
	}
	const traceId = (url.searchParams.get('trace_id') || '').trim();
	if (!traceId) return new Response('trace_id required', { status: 400 });

	// Resume cursor: header wins, ?seq= fallback (some clients can't set it).
	let cursor = parseLastEventId(request.headers.get('last-event-id'));
	if (cursor === 0) cursor = parseLastEventId(`x:${url.searchParams.get('seq') || ''}`);

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				clearInterval(poll);
				clearInterval(beat);
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};

			const pump = () => {
				if (closed || !fs.existsSync(serverConfig.memoryDbPath)) return;
				const db = new Database(serverConfig.memoryDbPath, { readonly: true });
				try {
					const rows = db
						.prepare(
							`SELECT id, action, target FROM chat_activity
							 WHERE trace_id = ? AND id > ? ORDER BY id ASC LIMIT 200`
						)
						.all(traceId, cursor) as { id: number; action: string; target: string | null }[];
					for (const r of rows) {
						controller.enqueue(
							encoder.encode(sseEvent(traceId, r.id, { action: r.action, target: r.target }))
						);
						cursor = r.id;
					}
					const job = getJob(traceId);
					if (job && ['done', 'failed', 'aborted'].includes(job.status)) {
						controller.enqueue(
							encoder.encode(
								sseEvent(traceId, cursor + 1, {
									action: '__terminal__',
									status: job.status,
									result_ref: job.result_ref
								})
							)
						);
						close();
					}
				} catch {
					/* table may not exist yet */
				} finally {
					db.close();
				}
			};

			const poll = setInterval(pump, POLL_MS);
			const beat = setInterval(() => {
				if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`));
			}, HEARTBEAT_MS);
			request.signal.addEventListener('abort', close);
			pump(); // immediate replay on connect
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive'
		}
	});
};
```

- [ ] Type-check the new route:

```bash
npm run check 2>&1 | grep -A2 "dispatch/stream" || echo "no stream route type errors"
```

Expected: no errors referencing `dispatch/stream`.

- [ ] Commit:

```bash
git add src/lib/server/sseFormat.ts src/routes/api/chat/dispatch/stream/+server.ts tests/dispatch-stream.test.ts && git commit -m "feat(dispatch): SSE stream endpoint (trace:seq id, heartbeat, replay)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1c.2 — Job-row GET (reconciliation) + meter GET endpoints

**Files:** create `src/routes/api/chat/dispatch/[trace]/+server.ts`; create `src/routes/api/chat/dispatch/meter/+server.ts`

Per spec §4.5 (reconcile against a fresh GET of the job row) + §4.11 telemetry (meter). Both gated behind `companionDispatchEnabled`.

- [ ] Create `src/routes/api/chat/dispatch/[trace]/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runMode } from '$lib/server/config';
import { getJob } from '$lib/server/dispatchJobs';
import { getActivityForTrace } from '$lib/server/chatActivity';

export const GET: RequestHandler = async ({ params }) => {
	if (!runMode.companionDispatchEnabled) return json({ job: null });
	const traceId = (params.trace || '').trim();
	if (!traceId) return json({ error: 'trace required' }, { status: 400 });
	const job = getJob(traceId) ?? null;
	const activity = getActivityForTrace(traceId, 200);
	return json({ job, activity });
};
```

- [ ] Create `src/routes/api/chat/dispatch/meter/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runMode, serverConfig } from '$lib/server/config';
import { getMeter } from '$lib/server/dispatchUsage';
import { checkDailyCap } from '$lib/server/dispatchBrakes';

export const GET: RequestHandler = async () => {
	if (!runMode.companionDispatchEnabled) {
		return json({ enabled: false, count: 0, wallClockSeconds: 0, cap: 0, used: 0 });
	}
	const meter = getMeter();
	const cap = checkDailyCap();
	return json({
		enabled: true,
		count: meter.count,
		wallClockSeconds: meter.wallClockSeconds,
		cap: cap.cap,
		used: cap.used,
		windowMin: serverConfig.companionDispatchWindowMin
	});
};
```

- [ ] Type-check both routes:

```bash
npm run check 2>&1 | grep -A2 "dispatch/\[trace\]\|dispatch/meter" || echo "no dispatch GET route type errors"
```

Expected: no errors referencing those routes.

- [ ] Commit:

```bash
git add src/routes/api/chat/dispatch/ && git commit -m "feat(dispatch): job-row reconciliation GET + dispatch meter GET

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1c.3 — Client SSE controller with resume reconciliation

**Files:** create `src/lib/chat/dispatchStream.svelte.ts`; create `tests/dispatch-stream-client.test.ts`

Per spec §4.5 resume floor + §12-1c. A Svelte-5-runes controller (factory exposing `$state` via getters, matching the codebase convention) that: opens an `EventSource` via `resolve('/api/chat/dispatch/stream')`, dedupes by seq, recreates the stream on `visibilitychange` (PWA) + Capacitor `App` `resume` (native) with the last seq, and reconciles against `GET /api/chat/dispatch/[trace]`. The DOM/EventSource side is integration-tested live (companion-deploy-verify); here we unit-test the pure reconcile/dedupe logic split into a testable `reconcileRows` helper.

- [ ] Write the failing test `tests/dispatch-stream-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { reconcileRows } from '$lib/chat/dispatchReconcile';

describe('reconcileRows', () => {
	it('appends only rows with seq greater than the current cursor', () => {
		const existing = [{ seq: 1, action: 'reading', target: 'a' }];
		const fresh = [
			{ seq: 1, action: 'reading', target: 'a' },
			{ seq: 2, action: 'edited', target: 'b' }
		];
		const { rows, cursor } = reconcileRows(existing, fresh, 1);
		expect(rows.map((r) => r.seq)).toEqual([1, 2]);
		expect(cursor).toBe(2);
	});

	it('dedupes a replayed row already present', () => {
		const existing = [{ seq: 1, action: 'reading', target: 'a' }];
		const fresh = [{ seq: 1, action: 'reading', target: 'a' }];
		const { rows } = reconcileRows(existing, fresh, 1);
		expect(rows).toHaveLength(1);
	});
});
```

- [ ] Run it (expect FAIL — module missing):

```bash
npx vitest run tests/dispatch-stream-client.test.ts
```

- [ ] Create `src/lib/chat/dispatchReconcile.ts` (pure, testable):

```ts
export interface StreamRow {
	seq: number;
	action: string;
	target: string | null;
}

/** Merge fresh rows into existing by seq, dedupe, return the new high-water cursor. */
export function reconcileRows(
	existing: StreamRow[],
	fresh: StreamRow[],
	cursor: number
): { rows: StreamRow[]; cursor: number } {
	const bySeq = new Map<number, StreamRow>();
	for (const r of existing) bySeq.set(r.seq, r);
	let hi = cursor;
	for (const r of fresh) {
		bySeq.set(r.seq, r);
		if (r.seq > hi) hi = r.seq;
	}
	const rows = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
	return { rows, cursor: hi };
}
```

- [ ] Run it (expect PASS):

```bash
npx vitest run tests/dispatch-stream-client.test.ts
```

- [ ] Create `src/lib/chat/dispatchStream.svelte.ts` (the runes controller wiring the helper to EventSource + resume):

```ts
import { resolve } from '$app/paths';
import { App } from '@capacitor/app';
import { reconcileRows, type StreamRow } from './dispatchReconcile';

export interface DispatchStreamState {
	readonly rows: StreamRow[];
	readonly status: string;
	readonly resultRef: string | null;
}

// Factory: expose $state via GETTERS (codebase convention for runes modules).
export function createDispatchStream(traceId: string) {
	let rows = $state<StreamRow[]>([]);
	let status = $state('working');
	let resultRef = $state<string | null>(null);
	let cursor = 0;
	let es: EventSource | null = null;
	let removeAppResume: (() => void) | null = null;

	function ingest(
		seq: number,
		data: { action: string; target?: string | null; status?: string; result_ref?: string | null }
	) {
		if (data.action === '__terminal__') {
			status = data.status || 'done';
			resultRef = data.result_ref ?? null;
			return;
		}
		const merged = reconcileRows(
			rows,
			[{ seq, action: data.action, target: data.target ?? null }],
			cursor
		);
		rows = merged.rows;
		cursor = merged.cursor;
	}

	function open() {
		es?.close();
		const u = `${resolve('/api/chat/dispatch/stream')}?trace_id=${encodeURIComponent(traceId)}&seq=${cursor}`;
		es = new EventSource(u);
		es.onmessage = (ev) => {
			const seq = Number.parseInt((ev.lastEventId || '').split(':').pop() || '0', 10) || cursor + 1;
			try {
				ingest(seq, JSON.parse(ev.data));
			} catch {
				/* ignore */
			}
		};
		es.onerror = () => {
			// Browser auto-reconnects with Last-Event-ID; resume handler covers
			// the background-kill case explicitly.
		};
	}

	async function reconcile() {
		try {
			const r = await fetch(`${resolve('/api/chat/dispatch')}/${encodeURIComponent(traceId)}`);
			if (!r.ok) return;
			const b = await r.json();
			const fresh: StreamRow[] = (b.activity || []).map(
				(a: { id: number; action: string; target: string | null }) => ({
					seq: a.id,
					action: a.action,
					target: a.target
				})
			);
			const merged = reconcileRows(rows, fresh, cursor);
			rows = merged.rows;
			cursor = merged.cursor;
			if (b.job && ['done', 'failed', 'aborted'].includes(b.job.status)) {
				status = b.job.status;
				resultRef = b.job.result_ref ?? null;
			}
		} catch {
			/* offline; SSE will catch up */
		}
	}

	function onResume() {
		void reconcile().then(() => open());
	}

	function start() {
		open();
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') onResume();
		});
		App.addListener('resume', onResume).then((h) => {
			removeAppResume = () => void h.remove();
		});
	}

	function destroy() {
		es?.close();
		es = null;
		removeAppResume?.();
	}

	return {
		get rows() {
			return rows;
		},
		get status() {
			return status;
		},
		get resultRef() {
			return resultRef;
		},
		start,
		destroy
	};
}
```

- [ ] Type-check:

```bash
npm run check 2>&1 | grep -A2 "dispatchStream\|dispatchReconcile" || echo "no client controller type errors"
```

Expected: no errors referencing those files.

- [ ] Commit:

```bash
git add src/lib/chat/dispatchReconcile.ts src/lib/chat/dispatchStream.svelte.ts tests/dispatch-stream-client.test.ts && git commit -m "feat(dispatch): client SSE controller + resume reconciliation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1c.4 — Working bubble + inline dispatch chips components

**Files:** create `src/lib/components/WorkingBubble.svelte`; create `src/lib/components/DispatchChips.svelte`

Per spec §4.6 + §4.7. Styled per `companion-ui-design` (clean/premium magenta brand; reuse the cyan-accent activity-pill look at `chat/+page.svelte:957-978` for the live ticker). These are leaf presentational components driven by props; verification is browser-load per `companion-deploy-verify` (mandatory for UI). No unit test (presentational, no logic branch).

- [ ] Create `src/lib/components/WorkingBubble.svelte`:

```svelte
<script lang="ts">
	import type { StreamRow } from '$lib/chat/dispatchReconcile';

	let {
		worker,
		rows,
		status,
		resultRef,
		startedAt,
		onretry
	}: {
		worker: string;
		rows: StreamRow[];
		status: string;
		resultRef: string | null;
		startedAt: number;
		onretry?: () => void;
	} = $props();

	let elapsed = $state(0);
	$effect(() => {
		if (status !== 'working') return;
		const t = setInterval(() => {
			elapsed = Math.floor((Date.now() - startedAt) / 1000);
		}, 1000);
		return () => clearInterval(t);
	});

	const last = $derived(rows.length ? rows[rows.length - 1] : null);
	const mmss = $derived(`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`);
</script>

{#if status === 'working'}
	<div
		class="rounded-2xl border border-fuchsia-400/25 bg-fuchsia-950/15 px-4 py-3 backdrop-blur-md"
	>
		<div class="flex items-center gap-2">
			<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-fuchsia-400"></span>
			<span class="font-mono text-[12px] tracking-wide text-fuchsia-300">
				{worker} working · {mmss}
			</span>
		</div>
		{#if last}
			<div class="mt-1.5 font-mono text-[11px] text-fuchsia-200/70">
				{last.target ? `${last.action} ${last.target}` : last.action}
			</div>
		{/if}
	</div>
{:else if status === 'done'}
	<div
		class="rounded-2xl border border-emerald-400/20 bg-emerald-950/10 px-4 py-2 text-[12px] text-emerald-200/80"
	>
		Done{resultRef ? ` — ${resultRef}` : ''}
	</div>
{:else}
	<div
		class="rounded-2xl border border-red-400/25 bg-red-950/15 px-4 py-2 text-[12px] text-red-200/80"
	>
		{status === 'aborted' ? 'Aborted' : 'Failed'}
		{#if onretry}
			<button class="ml-2 underline" onclick={onretry}>Retry</button>
		{/if}
	</div>
{/if}
```

- [ ] Create `src/lib/components/DispatchChips.svelte`:

```svelte
<script lang="ts">
	let {
		worker,
		brief,
		onapprove,
		onskip,
		onedit
	}: {
		worker: string;
		brief: string;
		onapprove: () => void;
		onskip: () => void;
		onedit: (brief: string) => void;
	} = $props();

	let editing = $state(false);
	let draft = $state(brief);
</script>

<div class="rounded-2xl border border-fuchsia-400/25 bg-fuchsia-950/10 px-4 py-3">
	<div class="text-[12px] text-fuchsia-200/90">
		Sully wants to send this to <strong>{worker === 'claude-code' ? 'CC' : 'AGY'}</strong>
	</div>
	{#if editing}
		<textarea
			class="mt-2 w-full rounded-lg border border-fuchsia-400/20 bg-black/30 p-2 text-[12px] text-fuchsia-100"
			bind:value={draft}
			rows="2"
		></textarea>
	{:else}
		<div class="mt-1 text-[12px] text-fuchsia-100/70">{brief}</div>
	{/if}
	<div class="mt-2 flex gap-2">
		<button
			class="rounded-full bg-fuchsia-500/90 px-3 py-1 text-[12px] text-white transition-all active:scale-95"
			onclick={() => (editing ? onedit(draft) : onapprove())}
		>
			{editing ? 'Send edited' : 'Approve'}
		</button>
		<button
			class="rounded-full border border-fuchsia-400/30 px-3 py-1 text-[12px] text-fuchsia-200 transition-all active:scale-95"
			onclick={onskip}
		>
			Skip
		</button>
		{#if !editing}
			<button
				class="rounded-full border border-fuchsia-400/30 px-3 py-1 text-[12px] text-fuchsia-200 transition-all active:scale-95"
				onclick={() => (editing = true)}
			>
				Edit brief
			</button>
		{/if}
	</div>
</div>
```

- [ ] Type-check both components:

```bash
npm run check 2>&1 | grep -A2 "WorkingBubble\|DispatchChips" || echo "no component type errors"
```

Expected: no errors referencing those components.

- [ ] Commit:

```bash
git add src/lib/components/WorkingBubble.svelte src/lib/components/DispatchChips.svelte && git commit -m "feat(dispatch): Working bubble + inline approve/skip/edit chips

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1c.5 — Wire SSE controller + bubble into the chat page (replace pollActivity)

**Files:** modify `src/routes/chat/+page.svelte`

Per spec §4.6 + §10 Phase 1c. Replace the 5s `pollActivity` loop (`chat/+page.svelte:459-495`, started at `:844`, cleared at `:849`) with a per-trace SSE controller (1c.3). When a `system` chat row carries a `trace_id` starting with `sully-` and is not yet terminal, mount a `WorkingBubble` driven by `createDispatchStream`. The existing `activityPill` ephemeral UI (`:114`, `:957-978`) stays for non-`sully-` (kernel) traces in wired mode but is short-circuited in companion dispatch mode by the SSE bubble. Verify per `companion-deploy-verify`.

- [ ] Add imports near the existing component imports in `src/routes/chat/+page.svelte` (after the `resolve, base` import at `:14`):

```ts
import { createDispatchStream } from '$lib/chat/dispatchStream.svelte';
import WorkingBubble from '$lib/components/WorkingBubble.svelte';
import { clientSafeConfig } from '$lib/config/clientSafe';
```

> Note: if `$lib/config/clientSafe` is not the established client-config import in this file, use the existing client-config import already present (grep for `companionMode` usage in the page) — the load-bearing requirement is `companionDispatchEnabled` exposure; if absent, add `companionDispatchEnabled: serverConfig.mode === 'companion'` to `clientSafeConfig` in `config.ts` and read it here. Confirm the exact import before editing.

- [ ] Add the dispatch-stream registry state near `activityPill` (`chat/+page.svelte:114`):

```ts
// Active companion-dispatch SSE controllers, keyed by sully-* trace_id.
let dispatchStreams = $state<Record<string, ReturnType<typeof createDispatchStream>>>({});

function ensureDispatchStream(traceId: string) {
	if (dispatchStreams[traceId]) return dispatchStreams[traceId];
	const ctrl = createDispatchStream(traceId);
	ctrl.start();
	dispatchStreams = { ...dispatchStreams, [traceId]: ctrl };
	return ctrl;
}
```

- [ ] In `onMount` (`chat/+page.svelte:843-844`), gate the legacy activity poll so companion dispatch uses SSE instead:

```ts
pollTimer = setInterval(pollMessages, 3000);
// Companion dispatch streams live activity over SSE (per-trace). The
// legacy 5s pollActivity loop only runs when SSE dispatch is NOT active.
if (!clientSafeConfig.companionDispatchEnabled) {
	activityTimer = setInterval(pollActivity, 5000);
}
```

- [ ] In `onDestroy` (`chat/+page.svelte:847-851`), tear down the streams:

```ts
clearInterval(pollTimer);
if (activityTimer) clearInterval(activityTimer);
for (const ctrl of Object.values(dispatchStreams)) ctrl.destroy();
```

- [ ] In the message-render loop (where `system` rows render), after a system row with a `sully-` trace_id, mount the bubble. Add this where messages are iterated (locate the `{#each}` over messages that renders bubbles), inside the per-message block:

```svelte
{#if m.sender === 'system' && m.trace_id?.startsWith('sully-')}
	{@const ctrl = ensureDispatchStream(m.trace_id)}
	<WorkingBubble
		worker={m.trace_id.includes('agy') ? 'gemini' : 'claude-code'}
		rows={ctrl.rows}
		status={ctrl.status}
		resultRef={ctrl.resultRef}
		startedAt={new Date(m.timestamp).getTime()}
	/>
{/if}
```

- [ ] Type-check the page:

```bash
npm run check 2>&1 | grep -A2 "chat/+page" || echo "no chat page type errors"
```

Expected: no errors referencing `chat/+page.svelte`.

- [ ] Build + deploy + browser-verify (mandatory for UI per operator rule; use the companion-deploy-verify skill loop):

```bash
npm run build && sudo systemctl restart logueos-companion
```

Then load `https://room.taila28611.ts.net:8444/companion/chat` on the iPhone viewport and confirm a `@cc` dispatch shows a live Working bubble that collapses on completion. (This is acceptance 1c "streams via the :8444 tailnet path and collapses to the final result".)

- [ ] Commit:

```bash
git add src/routes/chat/+page.svelte && git commit -m "feat(dispatch): wire SSE Working bubble into chat page (replace pollActivity)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1c.6 — Settings page: Autonomy segmented control + dispatch meter

**Files:** create `src/routes/settings/+page.svelte`; create `tests/autonomy-control.test.ts`

Per spec §4.7 (Autonomy: Ask · Auto-for-safe · Full-auto) + §4.11 meter (count + wall-clock). Phase 1 ships the `Ask` default. Autonomy persists per-device in `localStorage` under `companion-autonomy` (matching the `companion-tools-key` convention at `chat/+page.svelte:823`). The meter reads `GET /api/chat/dispatch/meter`. The pure persistence helper is unit-tested; the page is browser-verified.

- [ ] Write the failing test `tests/autonomy-control.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeAutonomy, AUTONOMY_DEFAULT } from '$lib/chat/autonomy';

describe('normalizeAutonomy', () => {
	it('defaults to Ask for unknown/empty values', () => {
		expect(normalizeAutonomy(null)).toBe('ask');
		expect(normalizeAutonomy('garbage')).toBe('ask');
		expect(AUTONOMY_DEFAULT).toBe('ask');
	});
	it('accepts the three valid modes', () => {
		expect(normalizeAutonomy('ask')).toBe('ask');
		expect(normalizeAutonomy('auto-safe')).toBe('auto-safe');
		expect(normalizeAutonomy('full-auto')).toBe('full-auto');
	});
});
```

- [ ] Run it (expect FAIL — module missing):

```bash
npx vitest run tests/autonomy-control.test.ts
```

- [ ] Create `src/lib/chat/autonomy.ts`:

```ts
export type Autonomy = 'ask' | 'auto-safe' | 'full-auto';
export const AUTONOMY_DEFAULT: Autonomy = 'ask';
const VALID: Autonomy[] = ['ask', 'auto-safe', 'full-auto'];

export function normalizeAutonomy(raw: string | null | undefined): Autonomy {
	return VALID.includes((raw || '') as Autonomy) ? (raw as Autonomy) : AUTONOMY_DEFAULT;
}
```

- [ ] Run it (expect PASS):

```bash
npx vitest run tests/autonomy-control.test.ts
```

- [ ] Create `src/routes/settings/+page.svelte`:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { normalizeAutonomy, type Autonomy } from '$lib/chat/autonomy';

	let autonomy = $state<Autonomy>('ask');
	let meter = $state<{ count: number; wallClockSeconds: number; used: number; cap: number } | null>(
		null
	);

	const modes: { id: Autonomy; label: string }[] = [
		{ id: 'ask', label: 'Ask' },
		{ id: 'auto-safe', label: 'Auto-for-safe' },
		{ id: 'full-auto', label: 'Full-auto' }
	];

	function setAutonomy(m: Autonomy) {
		autonomy = m;
		try {
			localStorage.setItem('companion-autonomy', m);
		} catch {
			/* ignore */
		}
	}

	onMount(async () => {
		try {
			autonomy = normalizeAutonomy(localStorage.getItem('companion-autonomy'));
		} catch {
			/* ignore */
		}
		try {
			const r = await fetch(resolve('/api/chat/dispatch/meter'));
			if (r.ok) meter = await r.json();
		} catch {
			/* ignore */
		}
	});

	const mmss = $derived(
		meter ? `${Math.floor(meter.wallClockSeconds / 60)}m ${meter.wallClockSeconds % 60}s` : '—'
	);
</script>

<div class="mx-auto max-w-md px-4 py-6" style="padding-top: env(safe-area-inset-top);">
	<h1 class="mb-4 text-lg font-semibold text-fuchsia-200">Settings</h1>

	<section class="mb-6">
		<h2 class="mb-2 text-[13px] text-fuchsia-200/70">Autonomy</h2>
		<div class="inline-flex rounded-full border border-fuchsia-400/25 bg-black/30 p-1">
			{#each modes as mode (mode.id)}
				<button
					class="rounded-full px-3 py-1 text-[12px] transition-all active:scale-95 {autonomy ===
					mode.id
						? 'bg-fuchsia-500/90 text-white'
						: 'text-fuchsia-200/70'}"
					onclick={() => setAutonomy(mode.id)}
				>
					{mode.label}
				</button>
			{/each}
		</div>
	</section>

	<section>
		<h2 class="mb-2 text-[13px] text-fuchsia-200/70">Dispatch meter (today)</h2>
		{#if meter?.enabled === false}
			<p class="text-[12px] text-fuchsia-200/50">Dispatch is disabled.</p>
		{:else if meter}
			<p class="text-[12px] text-fuchsia-100/80">
				{meter.count} dispatches · {mmss} worker wall-clock · {meter.used}/{meter.cap} cap
			</p>
		{:else}
			<p class="text-[12px] text-fuchsia-200/50">Loading…</p>
		{/if}
	</section>
</div>
```

- [ ] Type-check + build + browser-verify per `companion-deploy-verify`:

```bash
npm run check 2>&1 | grep -A2 "settings/+page\|chat/autonomy" || echo "no settings type errors"
npm run build && sudo systemctl restart logueos-companion
```

Then load `https://room.taila28611.ts.net:8444/companion/settings` on the iPhone viewport and confirm the segmented control defaults to Ask and the meter renders the count + wall-clock (acceptance 1c "the meter shows dispatch count + wall-clock").

- [ ] Commit:

```bash
git add src/routes/settings/+page.svelte src/lib/chat/autonomy.ts tests/autonomy-control.test.ts && git commit -m "feat(dispatch): settings autonomy segmented control + dispatch meter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1d — Full suite + acceptance verification

**Files:** none (verification only)

Per spec §12 acceptance 1a/1b/1c.

- [ ] Run the entire new test suite:

```bash
npx vitest run tests/dispatch-config.test.ts tests/dispatch-jobs.test.ts tests/decision-gate.test.ts tests/dispatch-brakes.test.ts tests/dispatch-usage.test.ts tests/companion-dispatch.test.ts tests/dispatch-stream.test.ts tests/dispatch-stream-client.test.ts tests/autonomy-control.test.ts
```

Expected: all PASS.

- [ ] Run the full project test + check (regression guard against existing suites):

```bash
npm run test && npm run check
```

Expected: no failures; no new type errors.

- [ ] Manual acceptance against §12 (with `COMPANION_DISPATCH_ENABLED=true` + `COMPANION_CALLBACK_SECRET` set in `.env`, deployed):
  - 1a: send `@cc` on a qualifying message → confirm a `pending_jobs` row reaches `dispatched`, and the worker callback writes `chat_activity` rows readable by `trace_id` (query `companion.db`).
  - 1b: confirm the gate refuses a trivial message; the schema-emission test passes; a simulated 429 trips the breaker (no retry); the kill switch aborts an in-flight job (`status=aborted`); fingerprint + rate-limiter block a looping dispatch; actual tokens land in `actual_*`.
  - 1c: confirm the SSE bubble streams via `:8444` and collapses to the final result; background→foreground recreates the stream + reconciles (no stale "working"); state survives a `sudo systemctl restart logueos-companion`; the meter shows count + wall-clock.

- [ ] No commit (verification step).

---

## Self-Review

**Spec-coverage check (§4.1-4.8, §4.11, §5, §6, §8, §10 Phase 1, §12 acceptance 1a/1b/1c):**

- §4.1 teacher = cloud Opus via the CLI bridge: honored — the gate schema rides the SAME `streamViaClaudeCLI` reply (Task 1b.3 `GATE_INSTRUCTION` is appended to that reply; no second model, no raw Bearer, no router). ✓
- §4.2 three-stage gate (rule pre-filter, deterministic value gate + injection guard, schema self-assessment + server-side validation): Tasks 1b.2 + 1b.3. ✓
- §4.3 enablement (companion-native flag, replace `:206` short-circuit, HMAC handoff), handoff `{task,scope,target_repo,brief,trace_id}`, `dispatchName=gemini`/`claude-code`: Tasks 1a.1, 1a.3, 1b.6. ✓
- §4.4 `pending_jobs` + state machine (`decided→dispatched→working→done|failed|retry|aborted`, keyed by trace_id, predicted_tokens telemetry-only): Task 1b.1. ✓
- §4.5 activity writer into `companion.db` (`writeActivity`), re-gate the activity route, SSE contract (`id: trace:seq`, response-init headers not `setHeaders`, ~15s heartbeat, resolve-base), resume reconciliation (`visibilitychange` + Capacitor `App` resume, Last-Event-ID replay, reconcile vs fresh GET): Tasks 1a.2, 1a.4, 1c.1, 1c.2, 1c.3. ✓
- §4.6 Working bubble: Task 1c.4 + 1c.5. ✓
- §4.7 inline chips + Settings autonomy segmented control: Tasks 1c.4, 1c.6. ✓
- §4.8 autonomy ladder: Phase 1 ships only the `Ask` control surface (the graduation mechanism is explicitly Phase 2 per §10) — `Ask` default is delivered (Task 1c.6); ladder graduation deferred (correct scope). ✓
- §4.11 brakes (dispatch-count budget, 429 breaker no-retry, token bucket, fingerprint, two-level kill switch that aborts in-flight) + actual-token capture into `actual_*` + Phase-1 meter (count + wall-clock): Tasks 1b.4, 1b.5, 1a.3 (kill-all), 1c.2 (meter). ✓
- §5 data flow: Tasks 1b.6 → 1a.3 → 1a.4 → 1c.1/1c.3 reproduce steps 1-9 (gate, dispatch, callback, SSE, reconcile). ✓
- §6 error handling: malformed decision → no escalation (validateGate `ok:false`); 429 → breaker; transient → bounded retry default 2 (`DEFAULT_RETRIES`, `canRetryAfter`); SSE drop/resume → recreate + replay; kill → abort. ✓
- §8 hardware: no resident classifier added (gate rides the cloud reply), no new local model — honored at design level; the Ollama systemd preconditions are a deployment note (not code in this plan; flagged as an open risk). ✓ (with risk noted)
- §10 Phase 1 (1a/1b/1c): fully decomposed. ✓
- §12 acceptance 1a/1b/1c: Task 1d verification maps each clause. ✓

**Placeholder scan:** No "TBD", "similar to Task N", or "add error handling" placeholders — every code block is concrete. The one conditional note (1c.5 `clientSafe` import) gives an explicit fallback instruction (add `companionDispatchEnabled` to `clientSafeConfig` if the import differs) rather than leaving it undefined; the worker is told exactly what to confirm and what to do. Defaults are pinned: retry=2 (`DEFAULT_RETRIES`), daily cap=20 (`COMPANION_DISPATCH_CAP`), window=1440min, value-gate complexity floor=280 chars + imperative verb, fingerprint cap=1/conversation, heartbeat=15s, breaker cooldown=5min, token bucket=5 burst / 1 per 30s.

**Type-consistency check across tasks:**

- `JobStatus` union (1b.1) is consumed identically by `companionDispatch` (1a.3), the activity route (1a.4), and the SSE/[trace] routes (1c.1/1c.2). ✓
- `PendingJob` `actual_*` columns (1b.1) match the `captureActualTokens` UPDATE (1b.5) and the `ResultMarker`/`MarkerUsage` shape (1b.5) which matches the verified `usage_capture.js` unified schema (`prompt/completion/cache_read/cache_creation/total`). ✓
- `ResultMarker` is exported from `dispatchUsage.ts` (1b.5) and imported by the activity route (1a.4) — single source. ✓
- `StreamRow` defined once in `dispatchReconcile.ts` (1c.3) and imported by `WorkingBubble.svelte` (1c.4) + `dispatchStream.svelte.ts` (1c.3). ✓
- HMAC: handoff to the listener uses `X-W4-HMAC` (matching the verified `dispatch-listener.ts:31-32` signer + `killWorker`); the worker→companion callback uses a DISTINCT `X-Companion-HMAC` with `companionCallbackSecret` (not the listener secret) — two separate trust boundaries, no key reuse. ✓
- `worker` value space: chat route resolves `claude-code`/`agy`/`auto` (existing `:122-128`); 1b.6 maps `agy→gemini` before calling `dispatchToWorker`, whose `DispatchInput.worker` is `'claude-code'|'gemini'` — consistent with the gate's `GateSchema.worker` union (1b.3) and `dispatchName` values in `workers.json` (`claude-code`, `gemini`). ✓
- `runMode.companionDispatchEnabled` (1a.1) is the single gate read by routes 1a.4, 1c.1, 1c.2 and the chat-page client flag (1c.5) — never aliased to `_wired`/`dispatchEnabled` (asserted by `tests/dispatch-config.test.ts`). ✓

**Issues found + fixed inline during review:**

1. Initial draft had the activity route reusing the listener HMAC secret — fixed to a distinct `companionCallbackSecret` + `X-Companion-HMAC` so a leaked callback secret can't sign listener dispatches.
2. Initial draft set SSE headers via `setHeaders` — corrected to response-init headers on `new Response(stream, { headers })` per spec §4.5 and the verified `speak-local/+server.ts:50` pattern.
3. `markWorking` after a terminal state would throw — wrapped the activity-callback transition in try/catch (1a.4) so a duplicate `completed` callback logs the row without 500-ing.

All checks pass; the plan is internally consistent and spec-complete for Phase 1 1a/1b/1c.
