import Database from 'better-sqlite3';
import { serverConfig } from './config';
import { WORKER_TEMPLATES, inferStageFromAction } from '$lib/work-surface/chatBridge.svelte';
import { workerBrandColor } from '$lib/utils/workerVisual';
import type {
	AggrStatus,
	PhaseKey,
	PhaseStatus,
	SeedPhase,
	SeedWorker,
	SeedFile,
	SeedSurface,
	SeedActivity
} from '$lib/work-surface/hybrid/hybrid-types';
import fs from 'node:fs';

export async function liveSurfaceFromTrace(traceId: string): Promise<SeedSurface | null> {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return null;

	const db = new Database(serverConfig.memoryDbPath);
	try {
		// Get the pending_jobs row
		const jobRow = db.prepare('SELECT * FROM pending_jobs WHERE trace_id = ?').get(traceId) as any;
		if (!jobRow) return null;

		// Get chat_activity rows for this trace
		const activityRows = db
			.prepare(
				`
            SELECT * FROM chat_activity 
            WHERE trace_id = ? 
            ORDER BY id ASC
        `
			)
			.all(traceId) as any[];

		// Map status to AggrStatus
		const aggrStatus = mapJobStatusToAggrStatus(jobRow.status);

		// Get worker info
		const workers = await buildWorkers(jobRow.worker, aggrStatus, activityRows);

		// Build phases
		const phases = buildPhases(activityRows, aggrStatus);

		// Build files
		const files = await buildFiles(activityRows);

		// Compute elapsed display
		const elapsedDisplay = computeElapsedDisplay(jobRow.started_at, jobRow.ended_at);

		// Build needs from gate_evaluated activity
		const needs = buildNeeds(activityRows);

		// Build humanized chronological activity log
		const activity = buildActivity(activityRows, workers[0]?.shortcode ?? 'CC');

		return {
			surfaceId: traceId,
			title: jobRow.brief || 'Working',
			createdAt: jobRow.started_at,
			aggr: aggrStatus,
			elapsedDisplay,
			needs,
			blockedBy: undefined,
			workers,
			phases,
			files,
			activity
		};
	} finally {
		db.close();
	}
}

function mapJobStatusToAggrStatus(status: string): 'running' | 'done' | 'failed' {
	switch (status) {
		case 'decided':
		case 'classified':
		case 'dispatched':
		case 'working':
			return 'running';
		case 'synthesized':
			return 'done';
		case 'aborted':
		case 'failed':
			return 'failed';
		default:
			console.warn(`Unknown pending_jobs.status: ${status}, defaulting to 'running'`);
			return 'running';
	}
}

function buildWorkers(workerId: string, aggrStatus: string, activityRows: any[]): SeedWorker[] {
	const template = WORKER_TEMPLATES[workerId] || WORKER_TEMPLATES['claude-code'];
	const fallbackTemplate = WORKER_TEMPLATES['claude-code'];
	const color = workerBrandColor(workerId, template.shortCode);

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

	// Map aggrStatus to worker status
	let workerStatus: 'running' | 'done' | 'failed';
	switch (aggrStatus) {
		case 'running':
			workerStatus = 'running';
			break;
		case 'done':
			workerStatus = 'done';
			break;
		case 'failed':
			workerStatus = 'failed';
			break;
		default:
			workerStatus = 'running';
	}

	return [
		{
			id: workerId,
			shortcode: template.shortCode,
			iconId: template.icon ?? fallbackTemplate.icon ?? 'icon-claude',
			color,
			status: workerStatus,
			currentStep,
			stepHistory
		}
	];
}

function formatActionText(action: string): string {
	// Simple transformation for human-readable text
	const map: Record<string, string> = {
		write_file: 'Writing file',
		thinking: 'Thinking',
		shell: 'Running shell command',
		tool_invoked: 'Invoking tool',
		tool_result: 'Processing tool result',
		finalizing: 'Finalizing',
		complete: 'Completing',
		gate_evaluated: 'Evaluating gate'
		// Add more mappings as needed
	};
	return map[action] || action;
}

function stageToKey(stage: string | null): PhaseKey | null {
	if (!stage) return null;
	return stage.toLowerCase() as PhaseKey;
}

function buildPhases(activityRows: any[], aggrStatus: string): SeedPhase[] {
	const pipelineStages = ['Read', 'Research', 'Build', 'Check', 'Approve', 'Reply'];
	const phaseMap: Record<string, SeedPhase> = {};

	// Track highest stage reached
	let highestStage: string | null = null;
	const stageTimestamps: Record<string, { first: string | null; last: string | null }> = {};

	for (const stage of pipelineStages) {
		stageTimestamps[stage] = { first: null, last: null };
	}

	for (const row of activityRows) {
		const stage = inferStageFromAction(row.action);
		if (stage) {
			if (!highestStage || pipelineStages.indexOf(stage) > pipelineStages.indexOf(highestStage)) {
				highestStage = stage;
			}

			// Track timestamps
			if (!stageTimestamps[stage].first) {
				stageTimestamps[stage].first = row.timestamp;
			}
			stageTimestamps[stage].last = row.timestamp;
		}
	}

	// Build phases
	const phases = pipelineStages.map((stage) => {
		const index = pipelineStages.indexOf(stage);
		const highestIndex = highestStage ? pipelineStages.indexOf(highestStage) : -1;

		let status: PhaseStatus;
		let reason: string | undefined;

		if (index < highestIndex) {
			status = 'done';
		} else if (index === highestIndex) {
			status = aggrStatus === 'running' ? 'active' : aggrStatus === 'done' ? 'done' : 'failed';
		} else {
			status = aggrStatus === 'running' ? 'pending' : 'skipped';
			reason = 'Not reached by worker';
		}

		return {
			key: stageToKey(stage)!,
			status,
			startedAt: stageTimestamps[stage].first,
			endedAt: stageTimestamps[stage].last,
			reason: status === 'skipped' ? reason : undefined
		};
	});

	// Handle zero activity rows case
	if (activityRows.length === 0 && aggrStatus === 'running') {
		phases[0].status = 'active';
	}

	return phases;
}

async function buildFiles(activityRows: any[]): Promise<SeedFile[]> {
	const files: SeedFile[] = [];

	for (const row of activityRows) {
		if (row.action === 'wrote_file' || row.action === 'created_artifact') {
			const path = row.target;
			if (path && fs.existsSync(path)) {
				const stat = fs.statSync(path);
				files.push({
					path,
					status: 'available',
					sizeBytes: stat.size,
					modifiedAt: stat.mtime.toISOString()
				});
			} else {
				files.push({
					path: path || 'unknown',
					status: 'failed',
					sizeBytes: 0,
					modifiedAt: null
				});
			}
		}
	}

	return files;
}

function computeElapsedDisplay(startedAt: string | null, endedAt: string | null): string {
	if (!startedAt) return '';

	const start = new Date(startedAt);
	const end = endedAt ? new Date(endedAt) : new Date();
	const elapsedMs = end.getTime() - start.getTime();

	const seconds = Math.floor(elapsedMs / 1000) % 60;
	const minutes = Math.floor(elapsedMs / (1000 * 60)) % 60;
	const hours = Math.floor(elapsedMs / (1000 * 60 * 60));

	let display = '';
	if (hours > 0) display += `${hours}h `;
	if (minutes > 0) display += `${minutes}m `;
	if (seconds > 0) display += `${seconds}s`;
	display = display.trim();

	if (endedAt) {
		if (endedAt === 'failed') {
			return `✕ ${display}`;
		} else {
			return `✓ ${display}`;
		}
	}
	return display;
}

/**
 * Build a humanized, chronological activity log from chat_activity rows.
 * Each row's raw (action, target) gets turned into a plain-English description
 * the operator can read at a glance ("CC is reading src/app.css" vs "reading").
 * The original target is retained for renderers that want to linkify or hover.
 */
function buildActivity(activityRows: any[], workerShortcode: string): SeedActivity[] {
	const out: SeedActivity[] = [];
	for (const row of activityRows) {
		const action = String(row.action || '');
		const target = (row.target ?? null) as string | null;
		const description = humanizeActivity(action, target, workerShortcode);
		const stage = inferStageFromAction(action);
		out.push({
			timestamp: row.timestamp,
			action,
			description,
			target,
			phase: stageToKey(stage)
		});
	}
	return out;
}

/**
 * Translate raw chat_activity (action, target) → plain English. The target
 * is sometimes a JSON blob (classifier_ran, verification_poll), sometimes
 * plain text (reading, edited, thinking). We branch on shape and pick the
 * description that gives the operator the most useful glance.
 */
function humanizeActivity(action: string, target: string | null, who: string): string {
	const parsed = parseMaybeJson(target);
	const text = parsed.json ? null : parsed.text;
	const json = parsed.json;

	switch (action) {
		case 'task_proposed':
			return 'Sully decided to take this on';
		case 'classifier_ran':
			return `Routed the task to ${who}`;
		case 'thinking':
			return text ? `Thinking — ${truncate(text, 140)}` : 'Thinking it through';
		case 'reading':
			return text ? `Reading ${truncate(text, 140)}` : 'Reading files';
		case 'tool_invoked':
			return text ? `Calling ${text}` : 'Using a tool';
		case 'tool_result':
			return 'Tool returned';
		case 'edited':
			return text ? `Edited ${text}` : 'Edited a file';
		case 'wrote_file':
		case 'write_file':
			return text ? `Wrote ${text}` : 'Wrote a file';
		case 'ran':
		case 'shell':
			return text ? `Ran: ${truncate(text, 120)}` : 'Running a command';
		case 'finalizing':
			return 'Wrapping up';
		case 'verification_poll': {
			const overall = json?.overall;
			if (overall === 'GO') return 'Verified — looks good';
			if (overall === 'NO_GO') return 'Verified — flagged issues';
			if (overall === 'warn') return 'Verified — wants a closer look';
			if (overall) return `Verifying — ${overall}`;
			return 'Verifying the work';
		}
		case 'adversary_reviewed': {
			const count = json?.count;
			if (typeof count === 'number') {
				return count === 0
					? 'Adversarial review — no issues'
					: `Adversarial review — ${count} finding${count === 1 ? '' : 's'}`;
			}
			return 'Adversarial review';
		}
		case 'synthesis_completed':
			return 'Synthesized the result';
		case 'reply_persisted':
			return 'Sent reply';
		case 'completed':
			return 'Done';
		case 'gate_evaluated':
			return 'Evaluated a gate';
		case 'created_artifact':
			return text ? `Created artifact ${text}` : 'Created an artifact';
		default:
			// Last-ditch readability: snake_case → "snake case".
			return action.replace(/_/g, ' ');
	}
}

function parseMaybeJson(target: string | null): { json: any; text: string | null } {
	if (!target) return { json: null, text: null };
	const t = target.trim();
	if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
		try {
			return { json: JSON.parse(t), text: null };
		} catch {
			/* fall through */
		}
	}
	return { json: null, text: target };
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1).trimEnd() + '…';
}

function buildNeeds(activityRows: any[]): { action: string; target: string } | undefined {
	const gateRow = [...activityRows].reverse().find((row) => row.action === 'gate_evaluated');
	if (!gateRow) return undefined;

	try {
		const payload = JSON.parse(gateRow.payload || '{}');
		return {
			action: payload.action || 'unknown',
			target: payload.target || 'unknown'
		};
	} catch {
		return undefined;
	}
}
