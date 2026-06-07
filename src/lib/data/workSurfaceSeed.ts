import type { WorkSurfaceTask, PipelineStage, TaskState, WorkerRole, WorkerStatus } from '$lib/types/workSurface';

export const workSurfaceSeed: Record<string, WorkSurfaceTask> = {
	'cc-researching': {
		traceId: 'seed-cc-researching',
		threadId: null,
		title: 'CC Schema Analysis',
		state: 'Working',
		stage: 'Research',
		stageProgress: [
			{ stage: 'Read', status: 'done' },
			{ stage: 'Research', status: 'active' },
			{ stage: 'Build', status: 'pending' },
			{ stage: 'Check', status: 'pending' },
			{ stage: 'Approve', status: 'skipped' },
			{ stage: 'Reply', status: 'pending' }
		],
		workers: [
			{
				identity: 'claude-code',
				shortCode: 'CC',
				display: 'Claude Code',
				role: 'Research',
				status: 'active',
				step: 'Researching index tables',
				icon: 'icon-claude'
			}
		],
		routing: {
			nodes: [
				{ id: 'core', kind: 'core', status: 'active' as WorkerStatus },
				{ id: 'claude-code', kind: 'worker', role: 'Research', status: 'active' as WorkerStatus }
			],
			edges: [{ from: 'claude-code', to: 'core', active: true }]
		},
		block: null,
		proof: { verdict: 'pending', score: null, checks: [] },
		result: null,
		isDestructive: false,
		startedAt: null,
		endedAt: null,
		ticketId: null
	},
	'agy-building': {
		traceId: 'seed-agy-building',
		threadId: null,
		title: 'Deck Handler Refinements',
		state: 'Working',
		stage: 'Build',
		stageProgress: [
			{ stage: 'Read', status: 'done' },
			{ stage: 'Research', status: 'skipped' },
			{ stage: 'Build', status: 'active' },
			{ stage: 'Check', status: 'pending' },
			{ stage: 'Approve', status: 'skipped' },
			{ stage: 'Reply', status: 'pending' }
		],
		workers: [
			{
				identity: 'antigravity',
				shortCode: 'AGY',
				display: 'Antigravity Agent',
				role: 'Build',
				status: 'active',
				step: 'Writing drag handlers',
				icon: 'icon-antigravity'
			}
		],
		routing: {
			nodes: [
				{ id: 'core', kind: 'core', status: 'active' as WorkerStatus },
				{ id: 'antigravity', kind: 'worker', role: 'Build', status: 'active' as WorkerStatus }
			],
			edges: [{ from: 'antigravity', to: 'core', active: true }]
		},
		block: null,
		proof: { verdict: 'pending', score: null, checks: [] },
		result: null,
		isDestructive: false,
		startedAt: null,
		endedAt: null,
		ticketId: null
	},
	'dpsk-verifying': {
		traceId: 'seed-dpsk-verifying',
		threadId: null,
		title: 'Sully is checking schema logic',
		state: 'Reviewing',
		stage: 'Check',
		stageProgress: [
			{ stage: 'Read', status: 'done' },
			{ stage: 'Research', status: 'skipped' },
			{ stage: 'Build', status: 'done' },
			{ stage: 'Check', status: 'active' },
			{ stage: 'Approve', status: 'skipped' },
			{ stage: 'Reply', status: 'pending' }
		],
		workers: [
			{
				identity: 'deepseek',
				shortCode: 'DPSK',
				display: 'DeepSeek',
				role: 'Review',
				status: 'active',
				step: 'Verifying trigger constraints',
				icon: 'icon-deepseek'
			}
		],
		routing: {
			nodes: [
				{ id: 'core', kind: 'core', status: 'active' as WorkerStatus },
				{ id: 'deepseek', kind: 'worker', role: 'Review', status: 'active' as WorkerStatus }
			],
			edges: [{ from: 'deepseek', to: 'core', active: true }]
		},
		block: null,
		proof: { verdict: 'pending', score: null, checks: [{ name: 'Schema check', status: 'pending', detail: '' }] },
		result: null,
		isDestructive: false,
		startedAt: null,
		endedAt: null,
		ticketId: null
	},
	'gmi-brainstorming': {
		traceId: 'seed-gmi-brainstorming',
		threadId: null,
		title: 'Context Log Synthesis',
		state: 'Working',
		stage: 'Research',
		stageProgress: [
			{ stage: 'Read', status: 'done' },
			{ stage: 'Research', status: 'active' },
			{ stage: 'Build', status: 'pending' },
			{ stage: 'Check', status: 'pending' },
			{ stage: 'Approve', status: 'skipped' },
			{ stage: 'Reply', status: 'pending' }
		],
		workers: [
			{
				identity: 'gemini',
				shortCode: 'GMI',
				display: 'Gemini',
				role: 'Research',
				status: 'active',
				step: 'Synthesizing log similarities',
				icon: 'icon-gmi'
			}
		],
		routing: {
			nodes: [
				{ id: 'core', kind: 'core', status: 'active' as WorkerStatus },
				{ id: 'gemini', kind: 'worker', role: 'Research', status: 'active' as WorkerStatus }
			],
			edges: [{ from: 'gemini', to: 'core', active: true }]
		},
		block: null,
		proof: { verdict: 'pending', score: null, checks: [] },
		result: null,
		isDestructive: false,
		startedAt: null,
		endedAt: null,
		ticketId: null
	},
	'cdx-reviewing': {
		traceId: 'seed-cdx-reviewing',
		threadId: null,
		title: 'Codebase Restructuring Audit',
		state: 'Reviewing',
		stage: 'Check',
		stageProgress: [
			{ stage: 'Read', status: 'done' },
			{ stage: 'Research', status: 'skipped' },
			{ stage: 'Build', status: 'done' },
			{ stage: 'Check', status: 'active' },
			{ stage: 'Approve', status: 'skipped' },
			{ stage: 'Reply', status: 'pending' }
		],
		workers: [
			{
				identity: 'codex',
				shortCode: 'CDX',
				display: 'Codex',
				role: 'Review',
				status: 'active',
				step: 'Auditing folder pathways',
				icon: 'icon-cdx'
			}
		],
		routing: {
			nodes: [
				{ id: 'core', kind: 'core', status: 'active' as WorkerStatus },
				{ id: 'codex', kind: 'worker', role: 'Review', status: 'active' as WorkerStatus }
			],
			edges: [{ from: 'codex', to: 'core', active: true }]
		},
		block: null,
		proof: { verdict: 'go', score: 94, checks: [{ name: 'Structure audit', status: 'pass', detail: 'Routes checked' }] },
		result: null,
		isDestructive: false,
		startedAt: null,
		endedAt: null,
		ticketId: null
	},
	'multi-worker': {
		traceId: 'seed-multi-worker',
		threadId: null,
		title: 'Coordinated Staging Build',
		state: 'Working',
		stage: 'Research', // First active stage in progress
		stageProgress: [
			{ stage: 'Read', status: 'done' },
			{ stage: 'Research', status: 'active' },
			{ stage: 'Build', status: 'active' },
			{ stage: 'Check', status: 'active' },
			{ stage: 'Approve', status: 'skipped' },
			{ stage: 'Reply', status: 'pending' }
		],
		workers: [
			{
				identity: 'claude-code',
				shortCode: 'CC',
				display: 'Claude Code',
				role: 'Research',
				status: 'active',
				step: 'Indexing schemas',
				icon: 'icon-claude'
			},
			{
				identity: 'antigravity',
				shortCode: 'AGY',
				display: 'Antigravity Agent',
				role: 'Build',
				status: 'active',
				step: 'Compiling code block',
				icon: 'icon-antigravity'
			},
			{
				identity: 'codex',
				shortCode: 'CDX',
				display: 'Codex',
				role: 'Review',
				status: 'active',
				step: 'Validating layout rules',
				icon: 'icon-cdx'
			}
		],
		routing: {
			nodes: [
				{ id: 'core', kind: 'core', status: 'active' as WorkerStatus },
				{ id: 'claude-code', kind: 'worker', role: 'Research', status: 'active' as WorkerStatus },
				{ id: 'antigravity', kind: 'worker', role: 'Build', status: 'active' as WorkerStatus },
				{ id: 'codex', kind: 'worker', role: 'Review', status: 'active' as WorkerStatus }
			],
			edges: [
				{ from: 'claude-code', to: 'core', active: true },
				{ from: 'antigravity', to: 'core', active: true },
				{ from: 'codex', to: 'core', active: true }
			]
		},
		block: null,
		proof: { verdict: 'pending', score: null, checks: [] },
		result: null,
		isDestructive: false,
		startedAt: null,
		endedAt: null,
		ticketId: null
	},
	'waiting-approval': {
		traceId: 'seed-waiting-approval',
		threadId: null,
		title: 'Safety Shield Intercepted',
		state: 'Waiting',
		stage: 'Approve',
		stageProgress: [
			{ stage: 'Read', status: 'done' },
			{ stage: 'Research', status: 'skipped' },
			{ stage: 'Build', status: 'active' },
			{ stage: 'Check', status: 'skipped' },
			{ stage: 'Approve', status: 'active' },
			{ stage: 'Reply', status: 'pending' }
		],
		workers: [
			{
				identity: 'antigravity',
				shortCode: 'AGY',
				display: 'Antigravity Agent',
				role: 'Build',
				status: 'idle', // Worker is idle while waiting for approval
				step: 'Halted at safe Gate',
				icon: 'icon-antigravity'
			}
		],
		routing: {
			nodes: [
				{ id: 'core', kind: 'core', status: 'active' as WorkerStatus },
				{ id: 'antigravity', kind: 'worker', role: 'Build', status: 'idle' as WorkerStatus }
			],
			edges: [] // No active edges when halted
		},
		block: { kind: 'approval', targetPath: 'production backup logs' },
		proof: { verdict: 'pending', score: null, checks: [] },
		result: null,
		isDestructive: true,
		startedAt: null,
		endedAt: null,
		ticketId: null
	},
	'complete': {
		traceId: 'seed-complete',
		threadId: null,
		title: 'Pipeline Executed Successfully',
		state: 'Complete',
		stage: 'Reply',
		stageProgress: [
			{ stage: 'Read', status: 'done' },
			{ stage: 'Research', status: 'skipped' },
			{ stage: 'Build', status: 'done' },
			{ stage: 'Check', status: 'done' },
			{ stage: 'Approve', status: 'skipped' },
			{ stage: 'Reply', status: 'done' }
		],
		workers: [
			{
				identity: 'claude-code',
				shortCode: 'CC',
				display: 'Claude Code',
				role: 'Build',
				status: 'done',
				step: 'Successful',
				icon: 'icon-claude'
			},
			{
				identity: 'antigravity',
				shortCode: 'AGY',
				display: 'Antigravity Agent',
				role: 'Build',
				status: 'done',
				step: 'Successful',
				icon: 'icon-antigravity'
			}
		],
		routing: {
			nodes: [
				{ id: 'core', kind: 'core', status: 'done' as WorkerStatus },
				{ id: 'claude-code', kind: 'worker', role: 'Build', status: 'done' as WorkerStatus },
				{ id: 'antigravity', kind: 'worker', role: 'Build', status: 'done' as WorkerStatus }
			],
			edges: [] // No active edges for complete task
		},
		block: null,
		proof: { verdict: 'go', score: 100, checks: [{ name: 'Deployment checks', status: 'pass', detail: 'All tests pass' }] },
		result: {
			project: 'sully-workspace',
			files: [{ path: 'demo/index.html', size: 1843, type: 'text/html', mtime: '2026-06-06T09:00:00Z' }],
			summary: 'All checks passed.'
		},
		isDestructive: false,
		startedAt: null,
		endedAt: null,
		ticketId: null
	},
	'stopped': {
		traceId: 'seed-stopped',
		threadId: null,
		title: 'Pipeline Halted',
		state: 'Stopped',
		stage: 'Build', // Halted while in Build stage
		stageProgress: [
			{ stage: 'Read', status: 'done' },
			{ stage: 'Research', status: 'skipped' },
			{ stage: 'Build', status: 'active' },
			{ stage: 'Check', status: 'skipped' },
			{ stage: 'Approve', status: 'skipped' },
			{ stage: 'Reply', status: 'skipped' }
		],
		workers: [], // No active workers once stopped
		routing: {
			nodes: [{ id: 'core', kind: 'core', status: 'stopped' as WorkerStatus }],
			edges: []
		},
		block: null,
		proof: { verdict: 'skipped', score: null, checks: [] },
		result: null,
		isDestructive: false,
		startedAt: null,
		endedAt: null,
		ticketId: null
	},
	'cur-implementing': {
		traceId: 'seed-cur-implementing',
		threadId: null,
		title: 'Work Surface brand icon wire-in',
		state: 'Working',
		stage: 'Build',
		stageProgress: [
			{ stage: 'Read', status: 'done' },
			{ stage: 'Research', status: 'skipped' },
			{ stage: 'Build', status: 'active' },
			{ stage: 'Check', status: 'pending' },
			{ stage: 'Approve', status: 'skipped' },
			{ stage: 'Reply', status: 'pending' }
		],
		workers: [
			{
				identity: 'cursor',
				shortCode: 'CUR',
				display: 'Cursor',
				role: 'Build',
				status: 'active',
				step: 'Inlining worker brand SVGs',
				icon: 'icon-cursor'
			}
		],
		routing: {
			nodes: [
				{ id: 'core', kind: 'core', status: 'active' as WorkerStatus },
				{ id: 'cursor', kind: 'worker', role: 'Build', status: 'active' as WorkerStatus }
			],
			edges: [{ from: 'cursor', to: 'core', active: true }]
		},
		block: null,
		proof: { verdict: 'pending', score: null, checks: [] },
		result: null,
		isDestructive: false,
		startedAt: null,
		endedAt: null,
		ticketId: null
	},
	'failed': {
		traceId: 'seed-failed',
		threadId: null,
		title: 'Pipeline Failed',
		state: 'Failed',
		stage: 'Build', // Failed while in Build stage
		stageProgress: [
			{ stage: 'Read', status: 'done' },
			{ stage: 'Research', status: 'skipped' },
			{ stage: 'Build', status: 'active' },
			{ stage: 'Check', status: 'skipped' },
			{ stage: 'Approve', status: 'skipped' },
			{ stage: 'Reply', status: 'skipped' }
		],
		workers: [], // No active workers once failed
		routing: {
			nodes: [{ id: 'core', kind: 'core', status: 'failed' as WorkerStatus }],
			edges: []
		},
		block: null,
		proof: {
			verdict: 'no-go',
			score: 0,
			checks: [{ name: 'Deployment checks', status: 'fail', detail: 'Container failed to start' }]
		},
		result: null,
		isDestructive: false,
		startedAt: null,
		endedAt: null,
		ticketId: null
	}
};

export const seedKeys = Object.keys(workSurfaceSeed);
