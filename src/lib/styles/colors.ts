import type { RunStatus } from '$lib/types/run';

export const statusColors: Record<RunStatus, string> = {
	CONFIRMED_WORKING: '#3FB950',
	INCONCLUSIVE: '#F5A623',
	FAILED: '#F85149',
	ESCALATE: '#3B82F6',
	unknown: '#6B7280'
};

// Per-worker colors are no longer hard-coded here — they live in the worker
// registry (workers.json). Use workerColor() from $lib/config/workers.
