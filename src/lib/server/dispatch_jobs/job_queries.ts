import fs from 'node:fs';
import { serverConfig } from '../config';
import { getDb } from './job_db';
import { RUNNING_STATES, TERMINAL_STATES, type PendingJob } from './job_types';

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

/**
 * Age out pre-flight rows that never reached dispatch: 'proposed'/'gated'/
 * 'held' older than AGEOUT_PROPOSAL_DAYS, 'classified' older than
 * AGEOUT_CLASSIFIED_HOURS → 'aborted'. These states can be a LIVE operator
 * session (a proposal awaiting confirm), which is why the thresholds are
 * generous — an age-blind cleanup would have destroyed real session rows in
 * the 2026-06-11 case. Threshold policy operator-approved 2026-07-07.
 *
 * Each bucket is ONE atomic UPDATE with the age+status predicate in the
 * WHERE clause — the status is re-checked at write time, so a proposal the
 * operator confirms between sweep ticks can never be clobbered back to
 * aborted (no SELECT-then-UPDATE window). Rows with NULL/malformed
 * started_at never match datetime() and are left alone by design.
 * Idempotent ('aborted' is terminal, never re-selected); the first sweep
 * after deploy performs the historical backfill.
 *
 * Returns per-bucket counts. A persistently non-zero `classified` count is
 * an upstream-leak signal: classified rows should normally be closed out by
 * markSelfHandled/expireTaskById within the turn, so ones old enough to age
 * out mean a turn-pipeline error path is skipping close-out.
 */
export const AGEOUT_PROPOSAL_DAYS = 7;
export const AGEOUT_CLASSIFIED_HOURS = 48;

export function reapAbandonedProposals(): { preflight: number; classified: number } {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return { preflight: 0, classified: 0 };
	const db = getDb();
	try {
		const now = new Date().toISOString();
		const preflight = db
			.prepare(
				`UPDATE pending_jobs
				 SET status = 'aborted',
				     current_activity = 'aged out: never confirmed or dispatched',
				     ended_at = ?
				 WHERE status IN ('proposed', 'gated', 'held')
				   AND datetime(started_at) < datetime('now', ?)`
			)
			.run(now, `-${AGEOUT_PROPOSAL_DAYS} days`).changes;
		const classified = db
			.prepare(
				`UPDATE pending_jobs
				 SET status = 'aborted',
				     current_activity = 'aged out: never confirmed or dispatched',
				     ended_at = ?
				 WHERE status = 'classified'
				   AND datetime(started_at) < datetime('now', ?)`
			)
			.run(now, `-${AGEOUT_CLASSIFIED_HOURS} hours`).changes;
		return { preflight, classified };
	} finally {
		db.close();
	}
}
