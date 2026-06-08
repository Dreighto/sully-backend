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
import path from 'node:path';

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

		// Build files from manifest
		const files = await buildFiles(activityRows);

		// Build evidence from wrote_file activity
		const evidence = activityRows
			.filter((row) => row.action === 'wrote_file' || row.action === 'write_file')
			.map((row) => ({ path: row.target }))
			.filter((ev) => ev.path);

		// Check for promotion warnings
		let promotionWarning: string | undefined;
		const failedPromotionCount = activityRows.filter(
			(row) => row.action === 'wrote_file' && row.target?.includes('promotion')
		).length;
		if (failedPromotionCount > 0) {
			promotionWarning = `${failedPromotionCount} deliverable${failedPromotionCount === 1 ? '' : 's'} couldn't be saved`;
		}

		// Compute elapsed display (glyph derived from status, not endedAt)
		const elapsedDisplay = computeElapsedDisplay(jobRow.started_at, jobRow.ended_at, aggrStatus);

		// Build needs from the gated proposal stashed in pending_jobs.result_ref
		const needs = buildNeeds(jobRow, aggrStatus);

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
			activity,
			evidence: evidence.length > 0 ? evidence : undefined,
			promotionWarning
		};
	} finally {
		db.close();
	}
}

function mapJobStatusToAggrStatus(status: string): AggrStatus {
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
			iconId: template.icon ?? fallbackTemplate.icon ?? 'icon-claude',
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

function stageToKey(stage: string | null): PhaseKey | null {
	if (!stage) return null;
	return stage.toLowerCase() as PhaseKey;
}

function buildPhases(activityRows: any[], aggrStatus: string): SeedPhase[] {
	const pipelineStages = ['Read', 'Research', 'Build', 'Check', 'Approve', 'Reply'];
	const stageTimestamps: Record<string, { first: string | null; last: string | null }> = {};
	for (const stage of pipelineStages) stageTimestamps[stage] = { first: null, last: null };

	// Walk activity, recording which stages ACTUALLY occurred + the furthest reached.
	let highestIndex = -1;
	for (const row of activityRows) {
		const stage = inferStageFromAction(row.action);
		if (!stage) continue;
		const idx = pipelineStages.indexOf(stage);
		if (idx > highestIndex) highestIndex = idx;
		if (!stageTimestamps[stage].first) stageTimestamps[stage].first = row.timestamp;
		stageTimestamps[stage].last = row.timestamp;
	}

	const terminal = aggrStatus === 'done' || aggrStatus === 'failed' || aggrStatus === 'stopped';

	const phases: SeedPhase[] = pipelineStages.map((stage, index) => {
		const hadActivity = stageTimestamps[stage].first !== null;
		let status: PhaseStatus;
		let reason: string | undefined;

		if (index < highestIndex) {
			// Below the furthest-reached stage. A stage is 'done' ONLY if it
			// actually had activity; a stage with no activity was bypassed this
			// run → 'skipped' (NOT a fake green 'done'). This is what makes
			// Research / Approve truthful — they had no action vocabulary to
			// drive them, so on a Read→Build→Reply run they correctly read as
			// skipped instead of falsely done. (CDX critical #8 + truth-guard #4.)
			if (hadActivity) {
				status = 'done';
			} else {
				status = 'skipped';
				reason = `No ${stage} step this run`;
			}
		} else if (index === highestIndex) {
			// The frontier stage the worker is on / ended on. Each terminal aggr
			// must map honestly — a STOPPED task was interrupted mid-stage, so the
			// frontier is NOT 'done' (that re-introduces the green-done truth bug);
			// mark it skipped-with-reason. needs-you / blocked surface their own.
			if (aggrStatus === 'running') {
				status = 'active';
			} else if (aggrStatus === 'failed') {
				status = 'failed';
			} else if (aggrStatus === 'needs-you') {
				status = 'needs-you';
			} else if (aggrStatus === 'blocked') {
				status = 'blocked';
			} else if (aggrStatus === 'stopped') {
				status = 'skipped';
				reason = 'Stopped here';
			} else {
				status = 'done';
			}
		} else {
			// Above the frontier — not reached.
			if (terminal) {
				status = 'skipped';
				reason = 'Not reached this run';
			} else {
				status = 'pending';
			}
		}

		return {
			key: stageToKey(stage)!,
			status,
			startedAt: stageTimestamps[stage].first,
			endedAt: stageTimestamps[stage].last,
			reason: status === 'skipped' ? reason : undefined
		};
	});

	// Zero activity yet but in-flight → Read is the implicit active stage.
	if (highestIndex === -1 && aggrStatus === 'running') {
		phases[0].status = 'active';
	}

	return phases;
}

import { findStoreDir, readManifest, artifactRepoRoot } from '$lib/server/artifactStore';

async function buildFiles(activityRows: any[]): Promise<SeedFile[]> {
	const repoRoot = artifactRepoRoot();
	const traceId = activityRows[0]?.trace_id;
	if (!traceId) return [];

	const storeDir = findStoreDir(repoRoot, traceId);
	if (!storeDir) return [];

	const manifest = readManifest(storeDir);
	const files: SeedFile[] = [];

	for (const meta of manifest) {
		try {
			const absolutePath = path.resolve(storeDir, meta.original_path);
			const stat = fs.statSync(absolutePath);
			files.push({
				path: meta.original_path,
				status: 'available',
				sizeBytes: stat.size,
				modifiedAt: stat.mtime.toISOString(),
				label: meta.label,
				importance: meta.importance
			});
		} catch {
			files.push({
				path: meta.original_path,
				status: 'failed',
				sizeBytes: 0,
				modifiedAt: null,
				label: meta.label,
				importance: meta.importance
			});
		}
	}

	// Sort by importance: primary → secondary → supporting
	const order = { primary: 0, secondary: 1, supporting: 2 };
	files.sort((a, b) => order[a.importance ?? 'secondary'] - order[b.importance ?? 'secondary']);

	return files;
}

function computeElapsedDisplay(
	startedAt: string | null,
	endedAt: string | null,
	aggr: AggrStatus
): string {
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

	// Glyph derived from STATUS, not endedAt (the old `endedAt === 'failed'`
	// check was impossible — endedAt is a timestamp — so failures showed ✓).
	switch (aggr) {
		case 'done':
			return `✓ ${display}`.trim();
		case 'failed':
			return `✕ ${display}`.trim();
		case 'stopped':
			return `■ ${display}`.trim(); // neutral stop glyph, not an error mark
		default:
			return display; // running / needs-you / blocked: bare elapsed
	}
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
		// null = internal plumbing the operator shouldn't see (routing shadows,
		// provider failover, brakes, etc.) — filtered out of the log entirely.
		if (description === null) continue;
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
// Internal plumbing actions the operator should NOT see in the activity log.
// Returning null from humanizeActivity() drops the row entirely.
const HIDDEN_ACTIONS = new Set<string>([
	'turn_decision_shadow', // shadow routing prediction (Hermes)
	'brakes_evaluated', // internal rate/safety brake check
	'provider_attempted', // internal LLM provider selection
	'provider_fell_through', // internal LLM failover
	'gate_evaluated' // internal dispatch gate (its payload drives needs, not the log)
]);

/**
 * Translate raw chat_activity (action, target) → plain English, or null to HIDE
 * the row (internal plumbing). Every action in TASK_EVENT_ACTIONS is handled
 * explicitly; unknown actions Title-Case readably (never raw snake_case in the
 * operator-facing UI). CDX critical #9.
 */
function humanizeActivity(action: string, target: string | null, who: string): string | null {
	if (HIDDEN_ACTIONS.has(action)) return null;

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
		case 'synthesis_started':
			return 'Writing the answer';
		case 'verification_poll': {
			const overall = json?.overall;
			if (overall === 'GO') return 'Verified — looks good';
			if (overall === 'NO_GO') return 'Verified — flagged issues';
			if (overall === 'warn' || overall === 'hedge') return 'Verified — wants a closer look';
			if (overall) return 'Verified — wants a closer look';
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
		case 'guardrail_triggered':
			return text
				? `Guardrail stopped a step — ${truncate(text, 100)}`
				: 'A safety guardrail fired';
		case 'synthesis_completed':
			return 'Synthesized the result';
		case 'reply_persisted':
			return 'Sent reply';
		case 'completed':
		case 'complete':
			return 'Done';
		case 'failed':
			return text ? `Hit an error — ${truncate(text, 120)}` : 'Hit an error';
		case 'created_artifact':
			return text ? `Created artifact ${text}` : 'Created an artifact';
		default:
			// Unknown (e.g. a future worker action): readable Title Case, never
			// raw snake_case. "some_new_action" → "Some New Action".
			return action
				.replace(/_/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
				.replace(/\b\w/g, (c) => c.toUpperCase());
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

/**
 * What the operator needs to confirm, for a 'needs-you' surface. CDX critical
 * #2: the old version read a non-existent `payload` column off a gate_evaluated
 * activity row, so `needs` was always undefined and the needs-you banner showed
 * no actual ask. The real source is pending_jobs.result_ref, where
 * markGatedProposal() stashes the ProposalPayload (+ proposal_type). Only
 * relevant when the job is gated/held (→ aggr 'needs-you').
 */
function buildNeeds(
	jobRow: any,
	aggrStatus: AggrStatus
): { action: string; target: string } | undefined {
	if (aggrStatus !== 'needs-you') return undefined;

	let proposalType: string | undefined;
	let brief: string | undefined;
	if (jobRow?.result_ref) {
		try {
			const p = JSON.parse(jobRow.result_ref);
			proposalType = p.proposal_type;
			brief = (p.brief || p.task || '').toString();
		} catch {
			/* malformed result_ref — fall back to the job's brief below */
		}
	}
	const target = (brief || jobRow?.brief || 'this task').toString().slice(0, 200);
	const action = proposalType === 'routing_ask' ? 'Run this work separately?' : 'Run this task?';
	return { action, target };
}
