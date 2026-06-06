/**
 * Work Surface type system — the seam between the Work Surface frontend and the
 * Companion backend.
 *
 * Source of contract: docs/design/Sully_Work_Surface/work_surface_api_contract.md (v1 FINAL).
 * These types are a PROJECTION over the internal 13-state dispatch FSM
 * (src/lib/server/dispatchJobs.ts) — they do not replace it. The backend maps the
 * messy internal lifecycle onto this clean presentational model; the frontend renders it.
 *
 * Items flagged [future] support the full multi-worker team model; v1 populates a
 * single Build worker (plus a Review/DeepSeek worker once auto-verify is wired).
 */

/**
 * The 8 high-level lifecycle states. Drives the pill/card status color and the
 * "what is Sully doing" header.
 *
 * `Failed` is added beyond the model's 8 because the FSM has a real `failed` sink —
 * the UI must never render a failure as `Complete` (locked 2026-06-06, contract §11).
 */
export type TaskState =
	| 'Reading'
	| 'Planning'
	| 'Working'
	| 'Reviewing'
	| 'Waiting'
	| 'Delivering'
	| 'Complete'
	| 'Stopped'
	| 'Failed';

/**
 * The 6 pipeline stages on the horizontal timeline:
 * Read → Research → Build → Check → Approve → Reply.
 */
export type PipelineStage = 'Read' | 'Research' | 'Build' | 'Check' | 'Approve' | 'Reply';

/**
 * Per-stage status for the horizontal timeline. The frontend renders all 6 stages
 * always; the backend marks `skipped` for stages that don't occur this run.
 */
export interface StageStep {
	stage: PipelineStage;
	/** `skipped` = stage did not occur this run (e.g. Research with no research worker). */
	status: 'done' | 'active' | 'pending' | 'skipped';
	/** ISO timestamp — for the Expanded "phase times". */
	startedAt?: string;
	/** Stage duration in milliseconds — for the Expanded checklist. */
	durationMs?: number;
}

/**
 * Worker roles are stable interfaces (contract §5). Identities are swappable engines.
 */
export type WorkerRole = 'Research' | 'Build' | 'Review' | 'Memory' | 'Vision' | 'Voice';

/** Lifecycle status of a single worker. */
export type WorkerStatus = 'queued' | 'active' | 'done' | 'failed' | 'idle';

/**
 * A worker assigned to / active on the task, expressed as Role + Identity.
 */
export interface TaskWorker {
	/** Canonical worker id, e.g. 'claude-code'. */
	identity: string;
	/** Short code, e.g. 'CC' — dimmed in Compact, clear in Expanded (model §9). */
	shortCode: string;
	/** Display name, e.g. 'Claude Code' — shown in the Expanded registry. */
	display: string;
	role: WorkerRole;
	status: WorkerStatus;
	/** Live progress line (PendingJob.current_activity / heartbeat). */
	step?: string;
	/** Last file the worker touched. */
	lastFile?: string;
	/** Worktree slot, e.g. 'project-miru/w1' — targets /kill. */
	slot?: string;
	/**
	 * SVG sprite symbol id for the worker's bespoke icon, e.g. 'icon-claude'.
	 * Maps identity → the worker icon family kept from the mock
	 * (icon-claude | icon-antigravity | icon-gmi | icon-cdx | icon-deepseek).
	 */
	icon?: string;
}

/**
 * A node in the routing graph. The backend supplies nodes; the frontend computes
 * layout (the SVG engine lays out from node count — backend sends no coordinates).
 */
export interface GraphNode {
	id: string;
	/** 'core' = the Sully node; 'worker' = a dispatched worker. */
	kind: 'core' | 'worker';
	role?: WorkerRole;
	status: WorkerStatus;
}

/**
 * A directed payload-routing edge. The frontend animates edges where `active` is true.
 */
export interface GraphEdge {
	from: string;
	to: string;
	active: boolean;
}

/**
 * Node-graph data with no coordinates (contract §3, §5). Always includes one `core`
 * (Sully) node plus one node per worker.
 */
export interface RoutingGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/**
 * Block info present iff `state === 'Waiting'` — describes why the task is gated.
 */
export interface BlockInfo {
	/** The kind of block; 'approval' drives the Approve button binding (model §9). */
	kind: string;
	/** The target of a destructive action — shown verbatim, never hidden (model §8.III). */
	targetPath?: string;
}

/** A single automated check in the Expanded "automated test reports". */
export interface ProofCheck {
	/** e.g. 'commit present', 'build', 'vitest'. */
	name: string;
	status: 'pass' | 'fail' | 'pending' | 'skip';
	detail?: string;
}

/**
 * Verification result. Present from the Check stage onward. Maps from
 * PendingJob.verification_state / verification_ref / verification_evidence,
 * populated by the Go/No-Go path (verifyPoll.ts → completionClose.ts).
 */
export interface Proof {
	verdict: 'go' | 'no-go' | 'pending' | 'skipped';
	/** 0–100 confidence, optional. */
	score?: number | null;
	/** The Expanded "automated test reports". */
	checks: ProofCheck[];
	/** verification_ref — commit sha / journal link. */
	evidenceRef?: string;
}

/**
 * One result file entry, as returned by GET /api/chat/dispatch/[trace]/files.
 */
export interface ResultFile {
	/** Path relative to the workspace, e.g. 'demo/index.html'. */
	path: string;
	/** File size in bytes. */
	size: number;
	/** MIME type, e.g. 'text/html'. */
	type: string;
	/** ISO last-modified timestamp. */
	mtime: string;
}

/**
 * Result info. Present from the Delivering stage onward.
 */
export interface ResultInfo {
	/** Workspace project the result files live under, e.g. 'sully-workspace'. */
	project: string;
	/** Result files produced by the task (fetchable via the single-file endpoint). */
	files: ResultFile[];
	/** Optional summary / synthesis text shown with the result. */
	summary?: string;
}

/**
 * The canonical Task object — the projection the whole UI reads.
 * Returned by GET /api/chat/dispatch/[trace] (as `{ task, activity }`).
 */
export interface WorkSurfaceTask {
	traceId: string;
	threadId: string | null;
	/** PendingJob.brief — the one-line task description. */
	title: string;
	/** The 8 lifecycle states — drives the pill color (§3). */
	state: TaskState;
	/** Current position on the Read→…→Reply timeline (§4). */
	stage: PipelineStage;
	/** Per-stage status for the horizontal timeline (§4). */
	stageProgress: StageStep[];
	/** Active/assigned workers as Role + Identity (§5). */
	workers: TaskWorker[];
	/** Node graph data, no coordinates (§5). */
	routing: RoutingGraph;
	/** Present iff `state === 'Waiting'`. */
	block: BlockInfo | null;
	/** Present from the Check stage onward. */
	proof: Proof | null;
	/** Present from the Delivering stage onward. */
	result: ResultInfo | null;
	/** Gates the double-confirm Approve flow (model §8.I). */
	isDestructive: boolean;
	/** ISO timestamp. */
	startedAt: string | null;
	/** ISO timestamp. */
	endedAt: string | null;
	ticketId: string | null;
}

export type SurfaceStatus = 'idle' | 'running' | 'needs-you' | 'done' | 'failed';

export type EdgeStatus = 'pending' | 'active' | 'solid';

export interface Surface {
	surfaceId: string; // STABLE id
	spawnedFromMessageId: string;
	title: string;
	status: SurfaceStatus;
	task: WorkSurfaceTask; // the existing per-card data
	needs?: { kind: 'approval' | 'input'; prompt: string };
	createdAt: string;
	updatedAt: string;
}
