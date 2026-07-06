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
export const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
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
export const TERMINAL_STATES: ReadonlySet<JobStatus> = new Set([
	'done',
	'verified',
	'synthesized',
	'failed',
	'aborted'
]);
