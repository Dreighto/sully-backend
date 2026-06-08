import type { SeedSurface } from '$lib/work-surface/hybrid/hybrid-types';

export const SEED_RUNNING: SeedSurface = {
	surfaceId: 'seed-running',
	title: 'Audit the companion repo',
	aggr: 'running',
	elapsedDisplay: '1m 12s',
	workers: [
		{
			id: 'cc-1',
			shortcode: 'CC',
			iconId: 'icon-claude',
			color: '#f97316',
			status: 'running',
			currentStep: 'Scanning data layer for known debt',
			stepHistory: [
				'Read companion repo structure (149 files)',
				'Mapped API routes + component deps'
			]
		},
		{
			id: 'agy-1',
			shortcode: 'AGY',
			iconId: 'icon-antigravity',
			color: '#a855f7',
			status: 'running',
			currentStep: 'Cross-referencing API routes against tests',
			stepHistory: ['Analyzed test coverage gaps']
		}
	],
	phases: [
		{ key: 'read', status: 'done', startedAt: '14:01:00', endedAt: '14:01:45' },
		{ key: 'research', status: 'done', startedAt: '14:01:45', endedAt: '14:02:30' },
		{ key: 'build', status: 'active', startedAt: '14:02:30', endedAt: null },
		{ key: 'check', status: 'pending', startedAt: null, endedAt: null },
		{
			key: 'approve',
			status: 'skipped',
			startedAt: null,
			endedAt: null,
			reason: 'Read-only audit — no approval needed'
		},
		{ key: 'reply', status: 'pending', startedAt: null, endedAt: null }
	],
	files: [],
	createdAt: '14:01:00'
};

export const SEED_NEEDS_YOU: SeedSurface = {
	surfaceId: 'seed-needs',
	title: 'Clean data/talkback-logs',
	aggr: 'needs-you',
	elapsedDisplay: '⏸',
	workers: [
		{
			id: 'cc-2',
			shortcode: 'CC',
			iconId: 'icon-claude',
			color: '#f97316',
			status: 'needs-you',
			currentStep: 'Awaiting deletion approval',
			stepHistory: ['Scanned 3.2 GB of log files', 'Identified 847 deletable files']
		}
	],
	phases: [
		{ key: 'read', status: 'done', startedAt: '13:50:00', endedAt: '13:50:30' },
		{
			key: 'research',
			status: 'skipped',
			startedAt: null,
			endedAt: null,
			reason: 'Scope defined in task prompt'
		},
		{ key: 'build', status: 'done', startedAt: '13:50:30', endedAt: '13:52:00' },
		{ key: 'check', status: 'done', startedAt: '13:52:00', endedAt: '13:52:40' },
		{ key: 'approve', status: 'needs-you', startedAt: '13:52:40', endedAt: null },
		{ key: 'reply', status: 'pending', startedAt: null, endedAt: null }
	],
	files: [],
	needs: {
		action: 'Approve permanent deletion of 847 files (3.2 GB)',
		target: 'data/talkback-logs/'
	},
	createdAt: '13:50:00'
};

export const SEED_DONE: SeedSurface = {
	surfaceId: 'seed-done',
	title: 'Build demo/index.html',
	aggr: 'done',
	elapsedDisplay: '✓ 4m 31s',
	workers: [
		{
			id: 'cc-3',
			shortcode: 'CC',
			iconId: 'icon-claude',
			color: '#f97316',
			status: 'done',
			currentStep: 'Committed + replied',
			stepHistory: [
				'Read task · scoped workspace',
				'Built demo/index.html (42 lines)',
				'Verified commit 3d68a75 · GO'
			]
		}
	],
	phases: [
		{ key: 'read', status: 'done', startedAt: '14:02:00', endedAt: '14:02:15' },
		{
			key: 'research',
			status: 'skipped',
			startedAt: null,
			endedAt: null,
			reason: 'Scope fully defined, no external lookup needed'
		},
		{ key: 'build', status: 'done', startedAt: '14:02:15', endedAt: '14:04:17' },
		{ key: 'check', status: 'done', startedAt: '14:04:17', endedAt: '14:06:29' },
		{
			key: 'approve',
			status: 'skipped',
			startedAt: null,
			endedAt: null,
			reason: 'No destructive ops — auto-approved at 14:06:30'
		},
		{ key: 'reply', status: 'done', startedAt: '14:06:30', endedAt: '14:06:42' }
	],
	files: [
		{ path: 'demo/index.html', status: 'available', sizeBytes: 1680, modifiedAt: '14:04:17' },
		{ path: 'demo/README.md', status: 'available', sizeBytes: 320, modifiedAt: '14:06:10' }
	],
	createdAt: '14:02:00'
};

export const SEED_FAILED: SeedSurface = {
	surfaceId: 'seed-failed',
	title: 'Fix test suite failures',
	aggr: 'failed',
	elapsedDisplay: '✕ 30m',
	workers: [
		{
			id: 'cc-4',
			shortcode: 'CC',
			iconId: 'icon-claude',
			color: '#f97316',
			status: 'failed',
			currentStep: 'Timed out — 5 tests still failing',
			stepHistory: ['Read 214 test files', 'Fixed 7 of 12 failures']
		}
	],
	phases: [
		{ key: 'read', status: 'done', startedAt: '13:00:00', endedAt: '13:00:45' },
		{ key: 'research', status: 'done', startedAt: '13:00:45', endedAt: '13:02:00' },
		{ key: 'build', status: 'failed', startedAt: '13:02:00', endedAt: '13:30:00' },
		{ key: 'check', status: 'pending', startedAt: null, endedAt: null },
		{ key: 'approve', status: 'pending', startedAt: null, endedAt: null },
		{ key: 'reply', status: 'pending', startedAt: null, endedAt: null }
	],
	files: [],
	createdAt: '13:00:00'
};

export const ALL_SEEDS: Record<string, SeedSurface> = {
	running: SEED_RUNNING,
	'needs-you': SEED_NEEDS_YOU,
	done: SEED_DONE,
	failed: SEED_FAILED
};
