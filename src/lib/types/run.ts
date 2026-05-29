// CodeRabbit Major: previously included `| string` which silently
// neutered exhaustiveness on every consumer. Now an explicit union
// with a dedicated 'unknown' fallback. The /api/runs parser coerces
// any unrecognized backend value to 'unknown' so the type stays
// honest end-to-end (status-color/icon mappings can switch on
// RunStatus exhaustively without an `as never` escape hatch).
export type RunStatus = 'CONFIRMED_WORKING' | 'INCONCLUSIVE' | 'FAILED' | 'ESCALATE' | 'unknown';

export const RUN_STATUSES: readonly RunStatus[] = [
	'CONFIRMED_WORKING',
	'INCONCLUSIVE',
	'FAILED',
	'ESCALATE',
	'unknown'
] as const;

// Helper: coerce any backend status string to a typed RunStatus.
// Used by the /api/runs parser to normalize log rows. Keeps the
// type guarantee at the type-check level and at runtime.
export function coerceRunStatus(raw: unknown): RunStatus {
	if (typeof raw !== 'string') return 'unknown';
	return (RUN_STATUSES as readonly string[]).includes(raw) ? (raw as RunStatus) : 'unknown';
}

export interface Run {
	timestamp: string;
	ticket_id: string | null;
	status: RunStatus;
	summary: string;
	worker: string | null;
	trace_id: string | null;
	duration_ms: number | null;
	pr_number: number | null;
	branch: string | null;
	files_touched: string[];
	// Optional project tag from the completion-log row. When present, the UI
	// uses it to resolve repo + Linear team via PROJECT_REGISTRY. When absent
	// (legacy rows pre-agnosticism), the UI degrades to plain text instead of
	// guessing a default that could misroute the link.
	project_id: string | null;
}

export interface RunsResponse {
	runs: Run[];
	total_in_log: number;
	truncated: boolean;
}
