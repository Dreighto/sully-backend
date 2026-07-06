import fs from 'node:fs';
import { serverConfig } from '../config';
import { getDb } from './job_db';
import type { PendingJob } from './job_types';

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
