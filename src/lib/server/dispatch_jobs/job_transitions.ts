import fs from 'node:fs';
import { serverConfig } from '../config';
import { getDb } from './job_db';
import { TRANSITIONS, type JobStatus, type PendingJob } from './job_types';

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
