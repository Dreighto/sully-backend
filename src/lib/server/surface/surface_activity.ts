import { inferStageFromAction } from '$lib/work-surface/chatBridge.svelte';
import { stageToKey } from './surface_phases';
import type { AggrStatus, SeedActivity } from '$lib/work-surface/hybrid/hybrid-types';

export function computeElapsedDisplay(
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
export function buildActivity(activityRows: any[], workerShortcode: string): SeedActivity[] {
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
