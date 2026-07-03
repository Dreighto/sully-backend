import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';
import type { WorkerName } from './worker-registry';

// Task lifecycle states (Phase 1, task-first architecture). The original
// dispatch states (decided→…→done) are now the MIDDLE of a larger arc that
// begins at 'proposed' (a Task minted for every turn, before any routing
// decision) and ends at 'synthesized' (Sully posted her final answer). A
// pure-chat turn that never dispatches stays at 'proposed' in Phase 1 —
// advancing it through synthesis is Phase 3 work.
export type JobStatus =
	| 'proposed' // task created for this turn; no routing decision yet
	| 'classified' // tier/intent classified
	| 'gated' // gate fired — dispatch warranted
	| 'held' // brakes / cap / dedupe held the dispatch
	| 'decided' // committed to dispatch a worker
	| 'dispatched'
	| 'working'
	| 'done' // worker terminal (from the listener's perspective)
	| 'verified' // PR-merge / CI confirmed (Phase 4)
	| 'synthesized' // Sully posted her final answer (Phase 3) — terminal
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
	// Phase 1 Task-lifecycle columns (nullable; added via bootstrap migration).
	thread_id: string | null;
	source: string | null;
	classification_tier: string | null;
	classification_payload: string | null;
	verification_state: string | null;
	verification_ref: string | null;
	verification_evidence: string | null;
	synthesis_message_id: number | null;
	ticket_id: string | null;
}

// Allowed forward transitions across the full Task arc. proposed is the entry;
// synthesized/failed/aborted are sinks. The pre-dispatch states (classified/
// gated/held) can short-circuit straight to decided. done can fan to verified
// or synthesized. retry loops back to dispatched.
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
	proposed: ['classified', 'gated', 'held', 'decided', 'synthesized', 'aborted', 'failed'],
	classified: ['gated', 'held', 'decided', 'synthesized', 'aborted', 'failed'],
	gated: ['decided', 'held', 'aborted', 'failed'],
	held: ['decided', 'aborted', 'failed'],
	decided: ['dispatched', 'aborted', 'failed'],
	dispatched: ['working', 'done', 'failed', 'retry', 'aborted'],
	working: ['done', 'failed', 'retry', 'aborted'],
	retry: ['dispatched', 'aborted', 'failed'],
	done: ['verified', 'synthesized', 'failed'],
	verified: ['synthesized', 'failed'],
	synthesized: [],
	failed: [],
	aborted: []
};

// ── R1.0 — per-thread active-task primitive ────────────────────────────────
// These sets partition JobStatus into three buckets the Mutation Gate (R2)
// reads. Co-located with TRANSITIONS so the FSM definition and its consumers
// stay in sync.
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
			.get(threadId, ...[...TERMINAL_STATES]) as PendingJob | undefined;
		return row ?? null;
	} finally {
		db.close();
	}
}

/**
 * The most-recent RUNNING task on a thread (status in RUNNING_STATES), or null.
 * Used by the Mutation Gate (R2) instead of getActiveTaskForThread so the gate
 * never matches the current turn's own 'classified' row (which is pre-dispatch and
 * will always be the highest id after classifyAndTouchThread runs). A running task
 * can NEVER be the just-created current-turn row, so this excludes it cleanly.
 */
export function getRunningTaskForThread(threadId: string): PendingJob | null {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return null;
	const db = getDb();
	try {
		const inList = [...RUNNING_STATES].map(() => '?').join(',');
		const row = db
			.prepare(
				`SELECT * FROM pending_jobs WHERE thread_id = ? AND status IN (${inList}) ORDER BY id DESC LIMIT 1`
			)
			.get(threadId, ...[...RUNNING_STATES]) as PendingJob | undefined;
		return row ?? null;
	} finally {
		db.close();
	}
}

// The Task-lifecycle columns added in Phase 1. Kept here (not only in
// bootstrap.ts) so dispatchJobs is self-sufficient — a test or a code path that
// touches jobs before bootstrap runs still gets the full schema.
const TASK_COLUMNS: Record<string, string> = {
	thread_id: 'TEXT',
	source: 'TEXT',
	classification_tier: 'TEXT',
	classification_payload: 'TEXT',
	verification_state: 'TEXT',
	verification_ref: 'TEXT',
	verification_evidence: 'TEXT',
	synthesis_message_id: 'INTEGER',
	ticket_id: 'TEXT'
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
				fingerprint           TEXT NOT NULL DEFAULT '',
				thread_id             TEXT,
				source                TEXT,
				classification_tier   TEXT,
				classification_payload TEXT,
				verification_state    TEXT,
				verification_ref      TEXT,
				synthesis_message_id  INTEGER,
				ticket_id             TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_pending_jobs_status ON pending_jobs(status);
			CREATE INDEX IF NOT EXISTS idx_pending_jobs_fp ON pending_jobs(fingerprint);
			CREATE INDEX IF NOT EXISTS idx_pending_jobs_thread ON pending_jobs(thread_id);
		`);
		// Additive migration for a table that pre-existed without the Task columns.
		const have = new Set(
			(db.pragma('table_info(pending_jobs)') as { name: string }[]).map((c) => c.name)
		);
		for (const [col, type] of Object.entries(TASK_COLUMNS)) {
			if (!have.has(col)) db.exec(`ALTER TABLE pending_jobs ADD COLUMN ${col} ${type}`);
		}
		_ensured = true;
	}
	return db;
}

/**
 * Mint a 'proposed' Task row for a turn, before any routing decision. Called
 * for EVERY turn (text or voice, dispatched or not) so the Task is the unit of
 * work and the journal has a canonical row per turn. worker='sully' is the
 * sentinel for "self-handled, no external worker yet". INSERT OR IGNORE so a
 * re-entrant call (e.g. retry of the same task_id) is a no-op rather than a
 * UNIQUE violation.
 */
export function proposeTask(opts: {
	taskId: string;
	threadId: string;
	source: string;
	category: string;
	brief: string;
	classificationTier?: string | null;
	classificationPayload?: string | null;
}): void {
	const db = getDb();
	try {
		db.prepare(
			`INSERT OR IGNORE INTO pending_jobs
			 (trace_id, worker, status, category, brief, fingerprint, predicted_tokens,
			  thread_id, source, classification_tier, classification_payload)
			 VALUES (?, 'sully', 'proposed', ?, ?, '', 0, ?, ?, ?, ?)`
		).run(
			opts.taskId,
			opts.category,
			opts.brief,
			opts.threadId,
			opts.source,
			opts.classificationTier ?? null,
			opts.classificationPayload ?? null
		);
	} finally {
		db.close();
	}
}

/**
 * Commit a worker dispatch. Upsert-aware: when a 'proposed' Task row already
 * exists for this task_id (the normal Phase 1 path), PROMOTE it to 'decided'
 * and fill in the worker + fingerprint + predicted tokens, preserving the
 * thread_id/source/classification set by proposeTask. When no row exists
 * (defensive — e.g. a legacy caller), INSERT a fresh 'decided' row. trace_id
 * IS the task_id.
 */
export function createJob(opts: {
	traceId: string;
	worker: string;
	category: string;
	brief: string;
	fingerprint: string;
	predictedTokens: number;
	threadId?: string | null;
	source?: string | null;
	classificationTier?: string | null;
	classificationPayload?: string | null;
}): void {
	const db = getDb();
	try {
		db.prepare(
			`INSERT INTO pending_jobs
			 (trace_id, worker, status, category, brief, fingerprint, predicted_tokens,
			  thread_id, source, classification_tier, classification_payload)
			 VALUES (?, ?, 'decided', ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(trace_id) DO UPDATE SET
			   worker = excluded.worker,
			   status = 'decided',
			   category = excluded.category,
			   brief = excluded.brief,
			   fingerprint = excluded.fingerprint,
			   predicted_tokens = excluded.predicted_tokens,
			   thread_id = COALESCE(pending_jobs.thread_id, excluded.thread_id),
			   source = COALESCE(pending_jobs.source, excluded.source),
			   classification_tier = COALESCE(pending_jobs.classification_tier, excluded.classification_tier),
			   classification_payload = COALESCE(pending_jobs.classification_payload, excluded.classification_payload)`
		).run(
			opts.traceId,
			opts.worker,
			opts.category,
			opts.brief,
			opts.fingerprint,
			opts.predictedTokens,
			opts.threadId ?? null,
			opts.source ?? null,
			opts.classificationTier ?? null,
			opts.classificationPayload ?? null
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
/** Phase 4: PR-merge / CI confirmed the dispatched work landed. */
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
/** Phase 3: Sully posted her synthesized final answer; link it + close the arc. */
export function markSynthesized(traceId: string, synthesisMessageId: number): void {
	transition(traceId, 'synthesized', {
		synthesis_message_id: synthesisMessageId,
		ended_at: new Date().toISOString()
	});
}

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

/** The dispatch payload stashed on a 'gated' proposal until the operator confirms. */
export interface ProposalPayload {
	worker: WorkerName;
	category: string;
	brief: string;
	targetRepo: string;
	task: string;
	/** Role-dispatch (LOS role-dispatch): 'backend' | 'frontend'. Set on the auto/
	 *  default path so the confirm turn can role-route via dispatchToWorker. */
	role?: string;
	/** True = pin the concrete worker (explicit @worker override). False/undefined
	 *  with a role set = let the kernel rotate by role. Stashed in result_ref JSON
	 *  (no schema change) alongside the rest of the payload. */
	pinWorker?: boolean;
}
export interface PendingProposal extends ProposalPayload {
	taskId: string;
	threadId: string;
	/** Discriminator: 'dispatch' (ask-before-dispatch) | 'routing_ask' (running-task gate). Defaults to 'dispatch' for legacy rows missing the field. */
	proposalType: 'dispatch' | 'routing_ask';
}

/**
 * Phase 2 (ask-before-dispatch): mark a self-handled turn as a PROPOSAL awaiting
 * the operator's confirmation. proposed/classified → 'gated'; the full dispatch
 * payload is stashed in result_ref (unused until a worker completes) so the
 * confirm turn can fire it verbatim. Status-guarded so it can't clobber a turn
 * that already dispatched.
 *
 * proposalType discriminates between a normal ask-before-dispatch proposal
 * ('dispatch', default) and a running-task routing-ask ('routing_ask'). Stamped
 * into the result_ref JSON so no schema change is needed.
 */
export function markGatedProposal(
	traceId: string,
	proposal: ProposalPayload,
	proposalType: 'dispatch' | 'routing_ask' = 'dispatch'
): void {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return;
	const db = getDb();
	try {
		const row = db.prepare('SELECT status FROM pending_jobs WHERE trace_id = ?').get(traceId) as
			| { status: JobStatus }
			| undefined;
		if (!row || (row.status !== 'proposed' && row.status !== 'classified')) return;
		const stored = { ...proposal, proposal_type: proposalType };
		db.prepare(
			"UPDATE pending_jobs SET status = 'gated', worker = ?, category = ?, brief = ?, result_ref = ?, current_activity = 'awaiting operator confirmation' WHERE trace_id = ?"
		).run(proposal.worker, proposal.category, proposal.brief, JSON.stringify(stored), traceId);
	} finally {
		db.close();
	}
}

/**
 * The most-recent pending proposal ('gated') on a thread, payload parsed, or
 * null. The confirm flow consumes-or-expires it every turn, so at most one is
 * ever live (one-turn lifetime).
 */
/**
 * Expire (abort) ALL pending 'gated' proposals on a thread. Called UNCONDITIONALLY
 * at the start of every non-affirmation turn so a proposal can't outlive the
 * operator's immediate next reply — even on a turn that errors or yields an empty
 * reply (where maybeAutonomousDispatch is skipped). Also clears any stacked/
 * abandoned proposals so gated rows never leak. Returns how many it expired.
 */
export function expireProposalsForThread(threadId: string): number {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return 0;
	const db = getDb();
	try {
		const info = db
			.prepare(
				"UPDATE pending_jobs SET status = 'aborted', current_activity = 'proposal expired (operator moved on)', ended_at = ? WHERE thread_id = ? AND status = 'gated'"
			)
			.run(new Date().toISOString(), threadId);
		return info.changes;
	} finally {
		db.close();
	}
}

/**
 * Orphan rollback (Stage 1): abort a SINGLE turn's own Task by trace_id when the
 * turn terminated having emitted zero reply tokens and written no assistant row
 * (a pre-stream credential 503, or a stream that errored empty). Scoped to the
 * exact task and GUARDED to a pre-dispatch state ('proposed'/'classified') so it
 * can NEVER abort a task that went on to dispatch, gate a proposal ('gated'), or
 * synthesize — those own their own terminal path. Idempotent: a no-op (returns
 * false) if the row is missing or already past pre-dispatch. Direct UPDATE (not
 * transition()) — proposed/classified→aborted are both legal sinks and we never
 * want to throw into the turn pipeline. Returns true iff it aborted a row.
 */
export function expireTaskById(taskId: string): boolean {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return false;
	const db = getDb();
	try {
		const info = db
			.prepare(
				`UPDATE pending_jobs SET status = 'aborted',
				   current_activity = 'turn rolled back (zero-token orphan)', ended_at = ?
				 WHERE trace_id = ? AND status IN ('proposed', 'classified')`
			)
			.run(new Date().toISOString(), taskId);
		return info.changes > 0;
	} finally {
		db.close();
	}
}

export function getPendingProposal(threadId: string, maxAgeMinutes = 10): PendingProposal | null {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return null;
	const db = getDb();
	try {
		// Recency-bounded: a proposal older than maxAgeMinutes is ignored, so an
		// errored turn between propose and a much-later "yes" can't fire a stale
		// proposal (belt-and-suspenders alongside consume-or-expire-each-turn).
		// datetime() normalizes the space/ISO timestamp forms.
		const row = db
			.prepare(
				`SELECT trace_id, thread_id, result_ref FROM pending_jobs
				 WHERE thread_id = ? AND status = 'gated'
				   AND datetime(started_at) > datetime('now', ?)
				 ORDER BY id DESC LIMIT 1`
			)
			.get(threadId, `-${Math.floor(maxAgeMinutes)} minutes`) as
			| { trace_id: string; thread_id: string; result_ref: string | null }
			| undefined;
		if (!row || !row.result_ref) return null;
		try {
			const parsed = JSON.parse(row.result_ref) as ProposalPayload & { proposal_type?: string };
			const proposalType: 'dispatch' | 'routing_ask' =
				parsed.proposal_type === 'routing_ask' ? 'routing_ask' : 'dispatch';
			const { proposal_type: _pt, ...p } = parsed as typeof parsed & { proposal_type?: string };
			void _pt;
			return { taskId: row.trace_id, threadId: row.thread_id, proposalType, ...p };
		} catch {
			return null;
		}
	} finally {
		db.close();
	}
}

/**
 * Fetch a still-pending ('gated') proposal by its exact task id. The tap-to-
 * confirm endpoint targets the specific proposal the operator tapped (not "the
 * latest on the thread"), and returning ONLY 'gated' rows makes confirm safe
 * against double-tap + post-expiry taps: once consumed (gated→decided) or
 * expired (gated→aborted) this returns null, so a second tap can't re-dispatch.
 */
export function getProposalByTaskId(taskId: string): PendingProposal | null {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return null;
	const db = getDb();
	try {
		const row = db
			.prepare(
				"SELECT trace_id, thread_id, result_ref FROM pending_jobs WHERE trace_id = ? AND status = 'gated' LIMIT 1"
			)
			.get(taskId) as
			| { trace_id: string; thread_id: string; result_ref: string | null }
			| undefined;
		if (!row || !row.result_ref) return null;
		try {
			const parsed = JSON.parse(row.result_ref) as ProposalPayload & { proposal_type?: string };
			const proposalType: 'dispatch' | 'routing_ask' =
				parsed.proposal_type === 'routing_ask' ? 'routing_ask' : 'dispatch';
			const { proposal_type: _pt, ...p } = parsed as typeof parsed & { proposal_type?: string };
			void _pt;
			return { taskId: row.trace_id, threadId: row.thread_id, proposalType, ...p };
		} catch {
			return null;
		}
	} finally {
		db.close();
	}
}

/** All Task rows for a thread, newest first. Reader-API support (turn_replay). */
export function getJobsForThread(threadId: string, limit = 50): PendingJob[] {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = getDb();
	try {
		return db
			.prepare('SELECT * FROM pending_jobs WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?')
			.all(threadId, limit) as PendingJob[];
	} finally {
		db.close();
	}
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

/**
 * Phase 0: mark jobs FAILED when they have been in-flight (dispatched/working)
 * longer than timeoutMs with no terminal callback — a dropped worker. Returns
 * the rows it reaped so the caller can surface a "that task stalled" message.
 * Default 15 min. started_at is the anchor — set at row INSERT (proposeTask/
 * createJob), which for an in-flight job is at most moments before dispatch.
 */
export function reapStaleJobs(timeoutMs = 15 * 60 * 1000): PendingJob[] {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = getDb();
	try {
		// Normalize BOTH sides through SQLite's datetime() so a space-separated
		// CURRENT_TIMESTAMP and an ISO 'T…Z' string compare by real instant, not
		// lexically (' ' < 'T' would otherwise reap every fresh job).
		const modifier = `-${Math.floor(timeoutMs / 1000)} seconds`;
		const stale = db
			.prepare(
				`SELECT * FROM pending_jobs
				 WHERE status IN ('dispatched','working')
				   AND datetime(started_at) < datetime('now', ?)`
			)
			.all(modifier) as PendingJob[];
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
