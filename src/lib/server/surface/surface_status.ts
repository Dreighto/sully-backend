import { resolveWorkerTemplate } from '$lib/work-surface/chatBridge.svelte';
import { workerBrandColor } from '$lib/utils/workerVisual';
import type { AggrStatus, SeedWorker } from '$lib/work-surface/hybrid/hybrid-types';

export function mapJobStatusToAggrStatus(status: string): AggrStatus {
	switch (status) {
		case 'decided':
		case 'classified':
		case 'dispatched':
		case 'working':
		case 'retry':
			return 'running';
		case 'gated':
		case 'held':
			// Awaiting operator confirmation — surfaces as "needs you".
			return 'needs-you';
		case 'synthesized':
		case 'done':
		case 'verified':
			return 'done';
		case 'aborted':
			// Operator-initiated Stop — NEUTRAL, not an error. Distinct from failed.
			return 'stopped';
		case 'failed':
			return 'failed';
		default:
			console.warn(`Unknown pending_jobs.status: ${status}, defaulting to 'running'`);
			return 'running';
	}
}

export function buildWorkers(
	workerId: string,
	aggrStatus: string,
	activityRows: any[]
): SeedWorker[] {
	// LOS-205: resolve through the canonical alias map — kernel short ids
	// ('dpsk', 'gmi', …) hit their own template, and an unknown id renders
	// itself, never a silent CC masquerade.
	const template = resolveWorkerTemplate(workerId);
	const color = workerBrandColor(template.identity, template.shortCode);

	// Get latest action
	const latestActionRow = [...activityRows].reverse().find((row) => row.action);
	const currentStep = latestActionRow ? formatActionText(latestActionRow.action) : 'starting';

	// Build step history, deduplicating consecutive actions
	const stepHistory: string[] = [];
	let lastAction: string | null = null;
	for (const row of activityRows) {
		if (row.action && row.action !== lastAction) {
			stepHistory.push(formatActionText(row.action));
			lastAction = row.action;
		}
	}

	// Map aggrStatus → worker status 1:1. Must cover every terminal/blocked
	// state — falling through to 'running' on a stopped/failed/needs-you task
	// would make deriveAggr() report 'running' and the surface poll forever.
	let workerStatus: SeedWorker['status'];
	switch (aggrStatus) {
		case 'done':
			workerStatus = 'done';
			break;
		case 'failed':
			workerStatus = 'failed';
			break;
		case 'stopped':
			workerStatus = 'stopped';
			break;
		case 'needs-you':
			workerStatus = 'needs-you';
			break;
		case 'blocked':
			workerStatus = 'blocked';
			break;
		case 'running':
		default:
			workerStatus = 'running';
	}

	return [
		{
			id: workerId,
			shortcode: template.shortCode,
			iconId: template.icon ?? 'icon-worker',
			color,
			status: workerStatus,
			currentStep,
			stepHistory
		}
	];
}

// Short worker-step labels for worker.currentStep / stepHistory (the worker
// lane + pill glance). Operator-facing, so the default Title-Cases instead of
// leaking raw snake_case (CDX #9 sibling path — the activity LOG uses the
// richer humanizeActivity()).
function formatActionText(action: string): string {
	const map: Record<string, string> = {
		reading: 'Reading',
		edited: 'Editing',
		ran: 'Running',
		running: 'Running',
		shell: 'Running a command',
		thinking: 'Thinking',
		task_proposed: 'Starting',
		classifier_ran: 'Routing',
		tool_invoked: 'Using a tool',
		tool_result: 'Tool returned',
		write_file: 'Writing a file',
		wrote_file: 'Wrote a file',
		created_artifact: 'Creating artifact',
		finalizing: 'Wrapping up',
		synthesis_started: 'Writing the answer',
		synthesis_completed: 'Synthesized',
		verification_poll: 'Verifying',
		adversary_reviewed: 'Reviewing',
		guardrail_triggered: 'Guardrail fired',
		reply_persisted: 'Replied',
		complete: 'Done',
		completed: 'Done',
		failed: 'Hit an error'
	};
	if (map[action]) return map[action];
	// Unknown / internal: Title-Case, never raw snake_case.
	return action
		.replace(/_/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\b\w/g, (c) => c.toUpperCase());
}
