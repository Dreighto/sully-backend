// src/lib/work-surface/hybrid/hybrid-types.ts
export type PhaseKey = 'read' | 'research' | 'build' | 'check' | 'approve' | 'reply';
export type PhaseStatus =
	| 'done'
	| 'active'
	| 'pending'
	| 'skipped'
	| 'blocked'
	| 'needs-you'
	| 'failed';
export type FileStatus = 'available' | 'generating' | 'needs-approval' | 'failed' | 'superseded';
export type AggrStatus = 'running' | 'needs-you' | 'blocked' | 'done' | 'failed' | 'stopped';

export interface SeedPhase {
	key: PhaseKey;
	status: PhaseStatus;
	startedAt: string | null;
	endedAt: string | null;
	/** Required when status === 'skipped'. ≤ 80 chars in seed; full version shown in State C. */
	reason?: string;
}

export interface SeedWorker {
	id: string;
	shortcode: string;
	/** Symbol ID from WorkerIconSprite.svelte: 'icon-claude', 'icon-antigravity', etc. */
	iconId: string;
	/** CSS color string from workerBrandColor(). */
	color: string;
	status: 'running' | 'done' | 'needs-you' | 'blocked' | 'failed' | 'stopped';
	currentStep: string;
	stepHistory: string[];
}

export interface SeedFile {
	path: string;
	status: FileStatus;
	sizeBytes?: number;
	modifiedAt: string | null;
	label?: string;
	importance?: 'primary' | 'secondary' | 'supporting';
}

/**
 * One row in the surface's chronological activity log. Each row is a
 * humanized re-projection of a chat_activity event — the raw action +
 * target turned into a plain-English description the operator can read
 * at a glance. The `target` is retained for the rare case the UI wants
 * to render the raw payload (e.g. linkifying file paths).
 */
export interface SeedActivity {
	timestamp: string;
	/** Raw chat_activity.action — kept for filtering, debugging, color coding. */
	action: string;
	/** Plain-English description: "Sully picked CC", "CC is reading src/app.css". */
	description: string;
	/** Raw chat_activity.target verbatim (may be JSON, may be plain text, may be null). */
	target: string | null;
	/** PipelineStage this activity advanced (or null if it doesn't map to a stage). */
	phase: PhaseKey | null;
}

export interface SeedSurface {
	surfaceId: string;
	title: string;
	aggr: AggrStatus;
	workers: SeedWorker[];
	phases: SeedPhase[];
	files: SeedFile[];
	/**
	 * Full chronological activity log, humanized. Used by State C detail sheet
	 * and (last N entries) by State B's phase-lines display. Optional so
	 * older seeds / fixtures without activity still satisfy the type.
	 */
	activity?: SeedActivity[];
	/** Present only when aggr === 'needs-you'. */
	needs?: { action: string; target: string };
	/** Present only when aggr === 'blocked'. */
	blockedBy?: string;
	createdAt: string;
	/** Elapsed display string shown in pill and card footer. */
	elapsedDisplay: string;
	/** Evidence files (non-promoted) from wrote_file activity */
	evidence?: { path: string }[];
	/** Warning about failed promotions */
	promotionWarning?: string;
}
