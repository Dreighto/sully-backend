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
