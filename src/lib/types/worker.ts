/** The two work lanes a dispatch can belong to. */
export type Lane = 'backend' | 'frontend';

/**
 * One active dispatch — a live worktree lease. The Team screen renders one
 * JobCard per ActiveJob, grouped by `lane`.
 */
export interface ActiveJob {
	/** Short worktree-slot id, e.g. "project-miru/w1". Unique per concurrent job. */
	slot: string;
	/** Dispatch trace id — targets the kill action. */
	trace_id?: string;
	/** Registry worker id executing this job, e.g. "backend-1". */
	worker_id: string;
	/** The lane the work belongs to — the job's nature, not the worker's identity. */
	lane: Lane;
	ticket_id?: string;
	branch?: string;
	/** ISO timestamp the slot was leased (drives the elapsed display). */
	since?: string;
	/** Live progress step, enriched from the heartbeat log. */
	step?: string;
	last_file_written?: string;
}

/** A non-clean last exit for a worker with no active job — surfaced as a note. */
export interface WorkerNote {
	worker_id: string;
	last_exit_status: string;
}
