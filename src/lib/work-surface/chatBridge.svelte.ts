// Chat ↔ Work Surface bridge. Builds the initial WorkSurfaceTask projection
// from a dispatch proposal so the pill appears instantly on Run. Richer
// projection (stage transitions, live worker step text) is the follow-up
// pass — for now this is Path A: spawn-on-confirm, settle-on-terminal.
//
// Title extraction prefers the previous operator request when available
// (the proposal text is Sully's "want me to dispatch this?" — not the task
// itself). Falls back to compactGlanceTitle of the proposal.

import type {
	WorkSurfaceTask,
	TaskWorker,
	PipelineStage,
	StageStep,
	RoutingGraph
} from '$lib/types/workSurface';
import { compactGlanceTitle } from '$lib/utils/glanceText';

const PIPELINE_STAGES: PipelineStage[] = ['Read', 'Research', 'Build', 'Check', 'Approve', 'Reply'];

// Explicit per-identity sprite ids. Without these, WorkGraph falls back to
// defaultIconForRole(role) which maps Build→icon-antigravity — so CC was
// rendering as the AGY mark (operator caught 2026-06-07 in his "build me a
// mockup" surface). Identity always wins over role; role-fallback is only
// for unknown identities.
export const WORKER_TEMPLATES: Record<string, Omit<TaskWorker, 'status' | 'step'>> = {
	'claude-code': {
		identity: 'claude-code',
		shortCode: 'CC',
		display: 'Claude Code',
		role: 'Build',
		icon: 'icon-claude'
	},
	antigravity: {
		identity: 'antigravity',
		shortCode: 'AGY',
		display: 'Antigravity',
		role: 'Build',
		icon: 'icon-antigravity'
	},
	gemini: {
		identity: 'gemini',
		shortCode: 'GMI',
		display: 'Gemini',
		role: 'Build',
		icon: 'icon-gmi'
	},
	codex: {
		identity: 'codex',
		shortCode: 'CDX',
		display: 'Codex',
		role: 'Review',
		icon: 'icon-cdx'
	},
	deepseek: {
		identity: 'deepseek',
		shortCode: 'DPSK',
		display: 'DeepSeek',
		role: 'Build',
		icon: 'icon-deepseek'
	}
};

/** Read `@cc / @agy / @gemini` mentions from the proposal text. Default to CC. */
function inferWorkerIdentity(text: string): string {
	const lower = text.toLowerCase();
	if (lower.includes('@cc') || lower.includes('claude code')) return 'claude-code';
	if (lower.includes('@agy') || lower.includes('antigravity')) return 'antigravity';
	if (lower.includes('@gmi') || lower.includes('@gemini')) return 'gemini';
	if (lower.includes('@cdx') || lower.includes('codex')) return 'codex';
	if (lower.includes('@dpsk') || lower.includes('deepseek')) return 'deepseek';
	return 'claude-code';
}

function makeStageProgress(): StageStep[] {
	return PIPELINE_STAGES.map((stage, i) => ({
		stage,
		status: i === 0 ? 'active' : 'pending'
	}));
}

function makeRouting(workerId: string): RoutingGraph {
	return {
		nodes: [
			{ id: 'core', kind: 'core', status: 'active' },
			{ id: workerId, kind: 'worker', role: 'Build', status: 'active' }
		],
		edges: [{ from: workerId, to: 'core', active: true, dispatch_active: true }]
	};
}

/** Maps a raw worker action string to a Work Surface pipeline stage.
 *  Returns null if the action does not advance the stage. */
export function inferStageFromAction(action: string): PipelineStage | null {
	const lowerAction = action.toLowerCase().trim();

	// New explicit mappings from the table
	if (lowerAction === 'thinking') return 'Read';
	if (lowerAction === 'task_proposed') return 'Read';
	if (lowerAction === 'classifier_ran') return 'Read';
	if (lowerAction === 'reading') return 'Read';

	if (lowerAction === 'tool_invoked') return 'Build';
	if (lowerAction === 'tool_result') return 'Build';
	if (lowerAction === 'edited') return 'Build';
	if (lowerAction === 'running') return 'Build';
	if (lowerAction === 'ran') return 'Build';
	if (lowerAction === 'shell') return 'Build';

	if (lowerAction === 'verification_poll') return 'Check';
	if (lowerAction === 'adversary_reviewed') return 'Check';

	if (lowerAction === 'finalizing') return 'Reply';
	if (lowerAction === 'complete') return 'Reply';
	if (lowerAction === 'completed') return 'Reply';
	if (lowerAction === 'synthesis_completed') return 'Reply';
	if (lowerAction === 'reply_persisted') return 'Reply';

	// Implied existing patterns (from test example and context in prompt)
	if (lowerAction.startsWith('read_')) return 'Read';
	if (lowerAction.startsWith('write_')) return 'Build';

	// Actions that do not map to a stage
	if (lowerAction === 'turn_decision_shadow') return null;
	if (lowerAction === 'gate_evaluated') return null;

	// Default for unrecognized actions
	return null;
}

export interface InitialTaskInput {
	traceId: string;
	threadId?: string | null;
	/** The operator's original request (preferred — used as title). */
	requestText?: string;
	/** Sully's proposal text — used for worker inference + title fallback. */
	proposalText: string;
}

/** Build a minimal initial WorkSurfaceTask. State=Reading, stage=Read, one active worker. */
export function buildInitialTaskFromProposal(input: InitialTaskInput): WorkSurfaceTask {
	const workerId = inferWorkerIdentity(input.proposalText);
	const template = WORKER_TEMPLATES[workerId] ?? WORKER_TEMPLATES['claude-code'];
	const worker: TaskWorker = {
		...template,
		status: 'active',
		step: 'starting'
	};

	const sourceForTitle = (input.requestText || input.proposalText).trim();
	const title = compactGlanceTitle(sourceForTitle) || 'Working';

	return {
		traceId: input.traceId,
		threadId: input.threadId ?? null,
		title,
		state: 'Reading',
		stage: 'Read',
		stageProgress: makeStageProgress(),
		workers: [worker],
		routing: makeRouting(workerId),
		block: null,
		proof: null,
		result: null,
		isDestructive: false,
		startedAt: new Date().toISOString(),
		endedAt: null,
		ticketId: null
	};
}
