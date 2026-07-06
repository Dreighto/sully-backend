import fs from 'node:fs';
import { serverConfig } from '../config';
import { getDb } from './job_db';
import type { JobStatus } from './job_types';
import type { WorkerName } from '../worker-registry';

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

/**
 * The most-recent pending proposal ('gated') on a thread, payload parsed, or
 * null. The confirm flow consumes-or-expires it every turn, so at most one is
 * ever live (one-turn lifetime).
 */
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
