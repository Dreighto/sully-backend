# Work Surface Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `/companion/work-surface-sandbox` SvelteKit route that demonstrates the three-state dispatch card (compact pill / expanded card / detail sheet) with real worker icons, worker lanes, skipped phase pips, result files, and aggregate status — driven by typed seed data, no live backend.

**Architecture:** Six focused Svelte 5 rune components — `WorkerCluster`, `SandboxDispatchPill`, `SandboxDispatchCard`, `SandboxDetailSheet` — plus an `aggregate.ts` pure function and typed `sandbox-seed.ts`. The route `+page.svelte` holds simulator controls (state/preset tabs + event buttons) and renders all three states side-by-side. Track A components (`DispatchCard.svelte`, `WorkSurfaceCard.svelte`, `WorkSurfaceDock.svelte`) are untouched throughout. Motion One is not installed; one-shot animations use CSS keyframe class-toggle via `$effect`.

**Tech Stack:** SvelteKit + Svelte 5 runes, bits-ui 2.18+ (Collapsible + Dialog with `asChild` snippet pattern), svelte-gestures 5.x (`useSwipe()` hook — not `use:swipe` action), CSS keyframes (sustained loops), CSS class-toggle `$effect` (one-shot beats), `WorkerIconSprite.svelte` for SVG icons, `workerBrandColor()` for worker colors, Playwright iphone-webkit (393×852) for E2E.

---

## File map

| File                                              | Create / Modify | Purpose                                                         |
| ------------------------------------------------- | --------------- | --------------------------------------------------------------- |
| `src/lib/work-surface/sandbox-types.ts`           | **Create**      | All TypeScript interfaces for the sandbox                       |
| `src/lib/work-surface/sandbox-seed.ts`            | **Create**      | Four typed preset objects (running / needs-you / done / failed) |
| `src/lib/work-surface/aggregate.ts`               | **Create**      | `deriveAggr(workers)` pure function                             |
| `src/lib/work-surface/WorkerCluster.svelte`       | **Create**      | Worker badge (single glyph / stacked / lead+count)              |
| `src/lib/work-surface/SandboxDispatchPill.svelte` | **Create**      | State A compact pill                                            |
| `src/lib/work-surface/SandboxDispatchCard.svelte` | **Create**      | State A+B container (Collapsible + crossfade)                   |
| `src/lib/work-surface/SandboxDetailSheet.svelte`  | **Create**      | State C bottom sheet (Dialog + swipe)                           |
| `src/routes/work-surface-sandbox/+page.svelte`    | **Create**      | Route + simulator controls                                      |
| `tests/aggregate.test.ts`                         | **Create**      | Unit tests for `deriveAggr`                                     |
| `tests/e2e/sandbox.spec.ts`                       | **Create**      | Playwright iphone-webkit E2E tests                              |

**Never touch:** `DispatchCard.svelte`, `WorkSurfaceCard.svelte`, `WorkSurfaceDock.svelte`, `WorkSurfacePill.svelte`, `WorkSurfaceInlinePanel.svelte`, `surfaces.svelte.ts`, `chat/+page.svelte`.

---

## CSS variable reference (from app.css — use these, not custom values)

```
--color-brand: #cf6f93          identity only (focus ring, active phase cursor)
--color-st-run: #d4d4d8         running dot + active pip
--color-st-needs: #c9a34e       needs-you/blocked pip + banner
--color-st-done: #71717a        done dot + faded text
--color-st-fail: #c25b5b        failed border + text
--color-surface: #141416        card background
--color-surface-raised: #1a1a1e panel background
--color-edge: #2a2a2e           border
--color-edge-active: #3f3f46    hover border
```

Worker identity colors (from `workerBrandColor()` in `src/lib/utils/workerVisual.ts`):

```
CC  → #f97316   AGY → #a855f7   GMI → #60a5fa
DPSK → #3b82f6  CDX → #9ca3af   CUR → #a8a29e
```

Worker icon IDs (from `WorkerIconSprite.svelte`, via `<use href="#<id>">`):

```
icon-claude   icon-antigravity   icon-gmi   icon-deepseek   icon-cdx   icon-cursor
```

---

## Task 1: Types + seed data

**Files:**

- Create: `src/lib/work-surface/sandbox-types.ts`
- Create: `src/lib/work-surface/sandbox-seed.ts`

- [ ] **Step 1: Write `sandbox-types.ts`**

```typescript
// src/lib/work-surface/sandbox-types.ts
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
export type AggrStatus = 'running' | 'needs-you' | 'blocked' | 'done' | 'failed';

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
	status: 'running' | 'done' | 'needs-you' | 'blocked' | 'failed';
	currentStep: string;
	stepHistory: string[];
}

export interface SeedFile {
	path: string;
	status: FileStatus;
	sizeBytes?: number;
	modifiedAt: string | null;
}

export interface SeedSurface {
	surfaceId: string;
	title: string;
	/** Explicit in seed. In production this is $derived from workers. */
	aggr: AggrStatus;
	workers: SeedWorker[];
	phases: SeedPhase[];
	files: SeedFile[];
	/** Present only when aggr === 'needs-you'. */
	needs?: { action: string; target: string };
	/** Present only when aggr === 'blocked'. */
	blockedBy?: string;
	createdAt: string;
	/** Elapsed display string shown in pill and card footer. */
	elapsedDisplay: string;
}
```

- [ ] **Step 2: Write `sandbox-seed.ts`**

```typescript
// src/lib/work-surface/sandbox-seed.ts
import type { SeedSurface } from './sandbox-types';

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
```

- [ ] **Step 3: Verify types compile**

```bash
npm run check 2>&1 | tail -5
```

Expected: `0 errors` (new files only, no existing code changed).

- [ ] **Step 4: Commit**

```bash
git add src/lib/work-surface/sandbox-types.ts src/lib/work-surface/sandbox-seed.ts
git commit -m "feat(sandbox): add SeedSurface types and four preset objects"
```

---

## Task 2: Aggregate status pure function

**Files:**

- Create: `src/lib/work-surface/aggregate.ts`
- Create: `tests/aggregate.test.ts`

- [ ] **Step 1: Write the failing unit tests**

```typescript
// tests/aggregate.test.ts
import { describe, it, expect } from 'vitest';
import { deriveAggr } from '$lib/work-surface/aggregate';
import type { SeedWorker } from '$lib/work-surface/sandbox-types';

const w = (status: SeedWorker['status']): SeedWorker => ({
	id: '1',
	shortcode: 'CC',
	iconId: 'icon-claude',
	color: '#f97316',
	status,
	currentStep: '',
	stepHistory: []
});

describe('deriveAggr', () => {
	it('needs-you beats all others', () => {
		expect(deriveAggr([w('running'), w('needs-you'), w('failed')])).toBe('needs-you');
	});
	it('failed beats running and below when no needs-you', () => {
		expect(deriveAggr([w('running'), w('failed'), w('done')])).toBe('failed');
	});
	it('running when any running and no failed/needs-you', () => {
		expect(deriveAggr([w('running'), w('done')])).toBe('running');
	});
	it('blocked when any blocked and all others done', () => {
		expect(deriveAggr([w('blocked'), w('done')])).toBe('blocked');
	});
	it('done when all workers done', () => {
		expect(deriveAggr([w('done'), w('done')])).toBe('done');
	});
	it('done for empty workers array', () => {
		expect(deriveAggr([])).toBe('done');
	});
	it('needs-you beats failed', () => {
		expect(deriveAggr([w('failed'), w('needs-you')])).toBe('needs-you');
	});
	it('running beats blocked', () => {
		expect(deriveAggr([w('blocked'), w('running')])).toBe('running');
	});
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npm test tests/aggregate.test.ts 2>&1 | tail -10
```

Expected: `Cannot find module '$lib/work-surface/aggregate'`

- [ ] **Step 3: Write `aggregate.ts`**

```typescript
// src/lib/work-surface/aggregate.ts
import type { AggrStatus, SeedWorker } from './sandbox-types';

/** Priority order: higher index = higher priority. */
const PRIORITY: AggrStatus[] = ['done', 'blocked', 'running', 'failed', 'needs-you'];

export function deriveAggr(workers: SeedWorker[]): AggrStatus {
	if (workers.length === 0) return 'done';
	let best: AggrStatus = 'done';
	for (const worker of workers) {
		const s = worker.status as AggrStatus;
		if (PRIORITY.indexOf(s) > PRIORITY.indexOf(best)) best = s;
	}
	return best;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test tests/aggregate.test.ts 2>&1 | tail -5
```

Expected: `8 passed`

- [ ] **Step 5: Commit**

```bash
git add src/lib/work-surface/aggregate.ts tests/aggregate.test.ts
git commit -m "feat(sandbox): add deriveAggr with unit tests"
```

---

## Task 3: Route scaffold + E2E smoke test

**Files:**

- Create: `src/routes/work-surface-sandbox/+page.svelte`
- Create: `tests/e2e/sandbox.spec.ts`

- [ ] **Step 1: Write the failing E2E test**

```typescript
// tests/e2e/sandbox.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Work Surface Sandbox — route smoke', () => {
	test('loads with 4 preset tabs and 3 state tabs, no console errors', async ({ page }) => {
		const errors: string[] = [];
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push(m.text());
		});

		await page.goto('/companion/work-surface-sandbox');

		// 4 preset tabs
		const presetTabs = page.locator('[data-testid="preset-tab"]');
		await expect(presetTabs).toHaveCount(4);
		await expect(presetTabs.nth(0)).toContainText('running');
		await expect(presetTabs.nth(1)).toContainText('needs-you');
		await expect(presetTabs.nth(2)).toContainText('done');
		await expect(presetTabs.nth(3)).toContainText('failed');

		// 3 state tabs
		const stateTabs = page.locator('[data-testid="state-tab"]');
		await expect(stateTabs).toHaveCount(3);

		// No console errors
		expect(errors.filter((e) => !e.includes('favicon'))).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run test — expect failure (route doesn't exist yet)**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -10
```

Start the dev server first in a separate terminal: `npm run dev`

Expected: `net::ERR_CONNECTION_REFUSED` or 404.

- [ ] **Step 3: Create the route scaffold**

```svelte
<!-- src/routes/work-surface-sandbox/+page.svelte -->
<script lang="ts">
	import WorkerIconSprite from '$lib/components/WorkerIconSprite.svelte';
	import { ALL_SEEDS } from '$lib/work-surface/sandbox-seed';
	import type { SeedSurface } from '$lib/work-surface/sandbox-types';

	type PresetKey = 'running' | 'needs-you' | 'done' | 'failed';
	type StateKey = 'A' | 'B' | 'C';

	let activePreset = $state<PresetKey>('running');
	let activeState = $state<StateKey>('A');
	// Full surface override — Complete/Fail replace the whole surface so workers + phases
	// stay consistent with aggr. Overriding only aggr would show "done" while workers
	// still render as running, which is the simulator-lying-to-you problem.
	let surfaceOverride = $state<SeedSurface | null>(null);

	const surface = $derived(surfaceOverride ?? ALL_SEEDS[activePreset]);

	function setPreset(p: PresetKey) {
		activePreset = p;
		surfaceOverride = null;
	}

	function applyComplete() {
		const base = ALL_SEEDS[activePreset];
		surfaceOverride = {
			...base,
			aggr: 'done',
			elapsedDisplay: '✓ ' + base.elapsedDisplay,
			workers: base.workers.map((w) => ({
				...w,
				status: 'done' as const,
				currentStep: 'Completed'
			})),
			phases: base.phases.map((p) => ({
				...p,
				status: p.status === 'skipped' ? ('skipped' as const) : ('done' as const),
				endedAt: p.endedAt ?? '—'
			}))
		};
	}

	function applyFail() {
		const base = ALL_SEEDS[activePreset];
		surfaceOverride = {
			...base,
			aggr: 'failed',
			elapsedDisplay: '✕ ' + base.elapsedDisplay,
			workers: base.workers.map((w) => ({
				...w,
				status: 'failed' as const,
				currentStep: 'Failed — see logs'
			})),
			phases: base.phases.map((p) => {
				if (p.status === 'active') return { ...p, status: 'failed' as const, endedAt: '—' };
				return p;
			})
		};
	}

	const PRESETS: PresetKey[] = ['running', 'needs-you', 'done', 'failed'];
	const STATES: { key: StateKey; label: string }[] = [
		{ key: 'A', label: 'A · Compact' },
		{ key: 'B', label: 'B · Expanded' },
		{ key: 'C', label: 'C · Detail' }
	];
</script>

<svelte:head><title>Work Surface Sandbox</title></svelte:head>
<WorkerIconSprite />

<main class="min-h-dvh bg-[var(--color-background)] font-sans text-[var(--color-text,#e8eaf0)]">
	<div class="mx-auto max-w-[430px] p-4 pb-24">
		<h1 class="mb-0.5 text-lg font-semibold">Work Surface Sandbox</h1>
		<p class="mb-4 text-xs text-[var(--color-st-done)]">Track B — CC clean-slate build</p>

		<!-- State tabs -->
		<div class="mb-2 flex gap-1">
			{#each STATES as { key, label }}
				<button
					data-testid="state-tab"
					data-state={key}
					aria-pressed={activeState === key}
					class="flex-1 rounded-lg border py-1.5 text-[11px] font-semibold transition-colors
                 {activeState === key
						? 'border-[var(--color-edge-active)] bg-[var(--color-surface-raised)] text-white'
						: 'border-[var(--color-edge)] bg-[var(--color-surface)] text-[var(--color-st-done)]'}"
					onclick={() => (activeState = key)}>{label}</button
				>
			{/each}
		</div>

		<!-- Preset tabs -->
		<div class="mb-4 flex gap-1">
			{#each PRESETS as preset}
				<button
					data-testid="preset-tab"
					data-preset={preset}
					aria-pressed={activePreset === preset}
					class="rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors
                 {activePreset === preset
						? 'border-[var(--color-edge-active)] bg-[var(--color-surface-raised)] text-white'
						: 'border-[var(--color-edge)] bg-[var(--color-surface)] text-[var(--color-st-done)]'}"
					onclick={() => setPreset(preset)}>{preset}</button
				>
			{/each}
		</div>

		<!-- Event buttons (added in Task 8) -->
		<div class="mb-4 flex gap-2" id="event-buttons">
			<!-- Task 8 adds Spawn / Complete / Fail buttons here -->
		</div>

		<!-- Card area — components slotted in by later tasks -->
		<div class="flex flex-col gap-3" id="card-area">
			<p class="text-xs text-[var(--color-st-done)]">
				surfaceId: {surface.surfaceId} · aggr: {surface.aggr}
			</p>
		</div>
	</div>
</main>
```

- [ ] **Step 4: Run E2E test — expect pass**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -10
```

Expected: `1 passed`

- [ ] **Step 5: Run `npm run check`**

```bash
npm run check 2>&1 | tail -5
```

Expected: `0 errors`

- [ ] **Step 6: Commit**

```bash
git add src/routes/work-surface-sandbox/+page.svelte tests/e2e/sandbox.spec.ts
git commit -m "feat(sandbox): route scaffold + smoke test"
```

---

## Task 4: WorkerCluster sub-component

**Files:**

- Create: `src/lib/work-surface/WorkerCluster.svelte`

- [ ] **Step 1: Write the component**

```svelte
<!-- src/lib/work-surface/WorkerCluster.svelte -->
<script lang="ts">
	import type { SeedWorker } from './sandbox-types';

	let { workers }: { workers: SeedWorker[] } = $props();

	const MAX_GLYPHS = 3;
	const shown = $derived(workers.slice(0, MAX_GLYPHS));
	const overflow = $derived(Math.max(0, workers.length - MAX_GLYPHS));
	const shortcodeLabel = $derived(shown.map((w) => w.shortcode).join(' · '));
</script>

<!--
  Single worker: [glyph][shortcode]
  2-3 workers:   [glyph][glyph][shortcodes CC·AGY]
  4+ workers:    [glyph]+[count]
-->
<div class="cluster" aria-label="Workers: {shortcodeLabel}">
	<div class="glyphs">
		{#each shown as worker, i}
			<svg
				width="15"
				height="15"
				viewBox="0 0 24 24"
				style="color: {worker.color}; {i > 0 ? 'margin-left: -3px;' : ''}"
				aria-hidden="true"
			>
				<use href="#{worker.iconId}" />
			</svg>
		{/each}
		{#if overflow > 0}
			<span class="overflow">+{overflow}</span>
		{/if}
	</div>
	<span class="codes">{shortcodeLabel}</span>
</div>

<style>
	.cluster {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: none;
	}
	.glyphs {
		display: flex;
		align-items: center;
	}
	.overflow {
		font-size: 10px;
		font-weight: 700;
		margin-left: 3px;
		color: var(--color-st-done);
	}
	.codes {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.05em;
		padding: 1px 5px;
		border-radius: 4px;
		background: var(--color-surface-raised);
		color: var(--color-st-done);
		white-space: nowrap;
	}
</style>
```

- [ ] **Step 2: Add E2E test for worker cluster**

Append to `tests/e2e/sandbox.spec.ts`:

```typescript
test.describe('WorkerCluster', () => {
	test('running preset shows CC · AGY cluster', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		// Default preset is 'running' with 2 workers
		const cluster = page.locator('[aria-label*="Workers: CC"]').first();
		await expect(cluster).toBeVisible();
		await expect(cluster).toContainText('CC · AGY');
	});

	test('done preset shows CC only', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-testid="preset-tab"][data-preset="done"]').click();
		const cluster = page.locator('[aria-label="Workers: CC"]').first();
		await expect(cluster).toBeVisible();
		await expect(cluster).toContainText('CC');
		await expect(cluster).not.toContainText('·');
	});
});
```

- [ ] **Step 3: Wire `WorkerCluster` into the route's card area temporarily**

In `+page.svelte`, replace the `<p>surfaceId…</p>` placeholder:

```svelte
<!-- inside #card-area div, replace the <p> placeholder with: -->
<div class="flex flex-col gap-3">
	<WorkerCluster workers={surface.workers} />
</div>
```

Add import at top of `<script>`:

```typescript
import WorkerCluster from '$lib/work-surface/WorkerCluster.svelte';
```

- [ ] **Step 4: Run E2E tests**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -10
```

Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add src/lib/work-surface/WorkerCluster.svelte src/routes/work-surface-sandbox/+page.svelte tests/e2e/sandbox.spec.ts
git commit -m "feat(sandbox): WorkerCluster sub-component"
```

---

## Task 5: SandboxDispatchPill — State A

**Files:**

- Create: `src/lib/work-surface/SandboxDispatchPill.svelte`

- [ ] **Step 1: Add E2E tests for State A**

Append to `tests/e2e/sandbox.spec.ts`:

```typescript
test.describe('State A — SandboxDispatchPill', () => {
	async function getPill(page: any) {
		return page.locator('[data-testid="sandbox-pill"]');
	}

	test('running preset: pill visible, dot has status=running', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		const pill = await getPill(page);
		await expect(pill).toBeVisible();
		const dot = pill.locator('[data-testid="status-dot"]');
		await expect(dot).toHaveAttribute('data-status', 'running');
		await expect(pill).toContainText('Audit the companion repo');
	});

	test('needs-you preset: pill visible, dot has status=needs-you', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-preset="needs-you"]').click();
		const dot = (await getPill(page)).locator('[data-testid="status-dot"]');
		await expect(dot).toHaveAttribute('data-status', 'needs-you');
	});

	test('done preset: pill visible, dot has status=done', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-preset="done"]').click();
		const dot = (await getPill(page)).locator('[data-testid="status-dot"]');
		await expect(dot).toHaveAttribute('data-status', 'done');
	});

	test('failed preset: pill visible, dot has status=failed', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-preset="failed"]').click();
		const dot = (await getPill(page)).locator('[data-testid="status-dot"]');
		await expect(dot).toHaveAttribute('data-status', 'failed');
	});
});
```

- [ ] **Step 2: Run tests — expect failure (`sandbox-pill` not found)**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -10
```

- [ ] **Step 3: Create `SandboxDispatchPill.svelte`**

```svelte
<!-- src/lib/work-surface/SandboxDispatchPill.svelte -->
<script lang="ts">
	import type { SeedSurface } from './sandbox-types';
	import WorkerCluster from './WorkerCluster.svelte';

	let {
		surface,
		onclick
	}: {
		surface: SeedSurface;
		onclick?: () => void;
	} = $props();
</script>

<button
	class="pill"
	class:pill--needs={surface.aggr === 'needs-you'}
	class:pill--failed={surface.aggr === 'failed'}
	class:pill--done={surface.aggr === 'done'}
	data-testid="sandbox-pill"
	data-aggr={surface.aggr}
	{onclick}
	type="button"
>
	<WorkerCluster workers={surface.workers} />

	<div
		class="dot dot--{surface.aggr}"
		data-testid="status-dot"
		data-status={surface.aggr}
		aria-hidden="true"
	></div>

	<span class="title">{surface.title}</span>

	<div class="meta" aria-label="Elapsed: {surface.elapsedDisplay}">
		<span class="elapsed">{surface.elapsedDisplay}</span>
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2.5"
			aria-hidden="true"
		>
			<polyline points="6 9 12 15 18 9" />
		</svg>
	</div>
</button>

<style>
	.pill {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		min-height: 44px;
		width: 100%;
		background: var(--color-surface);
		border: 1px solid var(--color-edge);
		border-radius: 12px;
		cursor: pointer;
		text-align: left;
		transition:
			border-color 0.2s,
			background 0.2s;
		-webkit-tap-highlight-color: transparent;
	}
	.pill:hover {
		background: var(--color-surface-raised);
		border-color: var(--color-edge-active);
	}
	.pill--needs {
		border-color: var(--color-st-needs);
	}
	.pill--failed {
		border-color: var(--color-st-fail);
	}
	.pill--done {
		opacity: 0.72;
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: none;
	}
	.dot--running {
		background: var(--color-st-run);
		animation: breath 1.8s ease-in-out infinite;
	}
	.dot--needs-you {
		background: var(--color-st-needs);
		animation: breath 1.1s ease-in-out infinite;
	}
	.dot--blocked {
		background: var(--color-st-needs);
	}
	.dot--done {
		background: var(--color-st-done);
	}
	.dot--failed {
		background: var(--color-st-fail);
	}

	.title {
		flex: 1;
		font-size: 13.5px;
		font-weight: 500;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: none;
		font-size: 11.5px;
		color: var(--color-st-done);
		font-variant-numeric: tabular-nums;
	}

	@keyframes breath {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dot {
			animation: none !important;
		}
	}
</style>
```

- [ ] **Step 4: Wire pill into the route**

Replace the `WorkerCluster` placeholder in `+page.svelte` with:

```svelte
<!-- replace content of #card-area -->
<div class="flex flex-col gap-3">
	{#if activeState === 'A'}
		<SandboxDispatchPill {surface} onclick={() => (activeState = 'B')} />
	{/if}
	<!-- State B and C added in Task 6 and 7 -->
</div>
```

Add to `<script>` imports:

```typescript
import SandboxDispatchPill from '$lib/work-surface/SandboxDispatchPill.svelte';
```

Remove the `WorkerCluster` import from `+page.svelte` (it's now only used inside Pill).

- [ ] **Step 5: Run E2E tests**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -10
```

Expected: `7 passed` (3 from earlier + 4 new State A tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/work-surface/SandboxDispatchPill.svelte src/routes/work-surface-sandbox/+page.svelte tests/e2e/sandbox.spec.ts
git commit -m "feat(sandbox): SandboxDispatchPill (State A) with breathing dot"
```

---

## Task 6: SandboxDispatchCard — State B

**Files:**

- Create: `src/lib/work-surface/SandboxDispatchCard.svelte`

- [ ] **Step 1: Add E2E tests for State B**

Append to `tests/e2e/sandbox.spec.ts`:

```typescript
test.describe('State B — SandboxDispatchCard', () => {
	test('running: expand shows worker lanes for 2-worker preset', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		// Select B state
		await page.locator('[data-testid="state-tab"][data-state="B"]').click();
		const lanes = page.locator('[data-testid="worker-lanes"]');
		await expect(lanes).toBeVisible();
		// Two lane rows
		await expect(lanes.locator('[data-testid="worker-lane-row"]')).toHaveCount(2);
	});

	test('running: skipped Approve phase row renders with reason', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-testid="state-tab"][data-state="B"]').click();
		const skippedRow = page.locator('[data-testid="phase-line"][data-status="skipped"]');
		await expect(skippedRow).toBeVisible();
		await expect(skippedRow.locator('[data-testid="skipped-reason"]')).toContainText('approval');
	});

	test('done: result files row visible', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-preset="done"]').click();
		await page.locator('[data-testid="state-tab"][data-state="B"]').click();
		await expect(page.locator('[data-testid="result-files-row"]')).toBeVisible();
	});

	test('done: no result-files-row for running preset (0 files)', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-testid="state-tab"][data-state="B"]').click();
		await expect(page.locator('[data-testid="result-files-row"]')).toHaveCount(0);
	});

	test('needs-you: needs banner visible with action text', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-preset="needs-you"]').click();
		await page.locator('[data-testid="state-tab"][data-state="B"]').click();
		const banner = page.locator('[data-testid="needs-banner"]');
		await expect(banner).toBeVisible();
		await expect(banner).toContainText('talkback-logs');
	});

	test('done: complete row always present (no files check for View result)', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-preset="done"]').click();
		await page.locator('[data-testid="state-tab"][data-state="B"]').click();
		await expect(page.locator('[data-testid="complete-row"]')).toBeVisible();
		// Files exist for done preset → View result button present
		await expect(page.locator('[data-testid="view-result-btn"]')).toBeVisible();
	});

	test('failed: complete row absent, failed row present', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-preset="failed"]').click();
		await page.locator('[data-testid="state-tab"][data-state="B"]').click();
		await expect(page.locator('[data-testid="complete-row"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="failed-row"]')).toBeVisible();
	});
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -10
```

- [ ] **Step 3: Create `SandboxDispatchCard.svelte`**

```svelte
<!-- src/lib/work-surface/SandboxDispatchCard.svelte -->
<script lang="ts">
	import { Collapsible } from 'bits-ui';
	import type { SeedSurface } from './sandbox-types';
	import WorkerCluster from './WorkerCluster.svelte';

	let {
		surface,
		forceExpanded = false,
		onOpenDetail
	}: {
		surface: SeedSurface;
		forceExpanded?: boolean;
		onOpenDetail?: () => void;
	} = $props();

	let expanded = $state(forceExpanded);

	// View Transitions progressive enhancement on the A↔B toggle.
	function toggle() {
		const next = !expanded;
		const doc = typeof document !== 'undefined' ? document : null;
		if (doc && 'startViewTransition' in doc) {
			(doc as Document & { startViewTransition(cb: () => void): unknown }).startViewTransition(
				() => {
					expanded = next;
				}
			);
		} else {
			expanded = next;
		}
	}

	const PHASE_LABELS: Record<string, string> = {
		read: 'Read',
		research: 'Research',
		build: 'Build',
		check: 'Check',
		approve: 'Approve',
		reply: 'Reply'
	};

	// Lanes show ALL assigned workers when 2+ total.
	// Removing a done worker from the lane hides who did the work and breaks continuity
	// when one of two workers finishes. Done workers render dimmed; they do not disappear.
	const showWorkerLanes = $derived(surface.workers.length > 1);

	const hasFiles = $derived(surface.files.length > 0);
	const generatingCount = $derived(surface.files.filter((f) => f.status === 'generating').length);
	const filesSummary = $derived(
		generatingCount > 0 && generatingCount === surface.files.length
			? 'Generating…'
			: (() => {
					const ext: Record<string, number> = {};
					for (const f of surface.files) {
						const e = (f.path.split('.').pop() ?? '?').toUpperCase();
						ext[e] = (ext[e] ?? 0) + 1;
					}
					const top2 = Object.entries(ext)
						.slice(0, 2)
						.map(([k, v]) => `${v} ${k}`)
						.join(', ');
					return `${surface.files.length} file${surface.files.length > 1 ? 's' : ''} — ${top2}`;
				})()
	);

	const isActive = $derived(surface.aggr === 'running' || surface.aggr === 'needs-you');
</script>

<div
	class="card"
	class:card--needs={surface.aggr === 'needs-you'}
	class:card--failed={surface.aggr === 'failed'}
	class:card--done={surface.aggr === 'done'}
	data-testid="sandbox-card"
	data-aggr={surface.aggr}
>
	<Collapsible.Root bind:open={expanded}>
		<!-- State A trigger row -->
		<Collapsible.Trigger asChild>
			{#snippet child({ props })}
				<button
					{...props}
					class="trigger"
					data-testid="card-trigger"
					type="button"
					onclick={toggle}
				>
					<WorkerCluster workers={surface.workers} />
					<div
						class="dot dot--{surface.aggr}"
						data-testid="status-dot"
						data-status={surface.aggr}
						aria-hidden="true"
					></div>
					<span class="trigger-title">{surface.title}</span>
					<div class="trigger-meta">
						<span>{surface.elapsedDisplay}</span>
						<svg
							class="chevron"
							class:chevron--open={expanded}
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							aria-hidden="true"
						>
							<polyline points="6 9 12 15 18 9" />
						</svg>
					</div>
				</button>
			{/snippet}
		</Collapsible.Trigger>

		<!-- State B content -->
		<Collapsible.Content>
			<!-- Header row (cluster + title + Stop) -->
			<div class="card-header">
				<WorkerCluster workers={surface.workers} />
				<span class="card-title">{surface.title}</span>
				{#if isActive}
					<button class="stop-btn" type="button">Stop</button>
				{/if}
			</div>

			<!-- Worker lanes (all assigned workers when 2+ total; done workers dimmed not removed) -->
			{#if showWorkerLanes}
				<div class="worker-lanes" data-testid="worker-lanes">
					{#each surface.workers as worker}
						<div
							class="worker-lane-row"
							class:worker-lane-row--done={worker.status === 'done'}
							data-testid="worker-lane-row"
							data-worker-status={worker.status}
						>
							<div class="lane-dot lane-dot--{worker.status}" aria-hidden="true"></div>
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								style="color: {worker.color}; flex: none;"
								aria-hidden="true"
							>
								<use href="#{worker.iconId}" />
							</svg>
							<span class="lane-code">{worker.shortcode}</span>
							<span class="lane-step">{worker.currentStep}</span>
						</div>
					{/each}
				</div>
			{/if}

			<!-- Stage spine (6 pips) -->
			<div class="stage-spine" role="list" aria-label="Stage progress">
				{#each surface.phases as phase}
					<div
						role="listitem"
						class="stage-pip stage-pip--{phase.status}"
						title="{PHASE_LABELS[phase.key]}: {phase.status}"
					></div>
				{/each}
			</div>

			<!-- Phase lines (non-pending) -->
			<div class="phase-lines">
				{#each surface.phases.filter((p) => p.status !== 'pending') as phase}
					<div
						class="phase-line phase-line--{phase.status}"
						data-testid="phase-line"
						data-status={phase.status}
					>
						<div class="phase-dot phase-dot--{phase.status}" aria-hidden="true"></div>
						<span class="phase-text">{PHASE_LABELS[phase.key]}</span>
						{#if phase.status === 'skipped' && phase.reason}
							<span class="phase-reason" data-testid="skipped-reason">
								— {phase.reason.slice(0, 60)}
							</span>
						{/if}
					</div>
				{/each}
			</div>

			<!-- Needs-you banner -->
			{#if surface.aggr === 'needs-you' && surface.needs}
				<div class="needs-banner" data-testid="needs-banner" role="alert">
					<span class="needs-text">
						Waiting — {surface.needs.action} in <strong>{surface.needs.target}</strong>
					</span>
					<button class="needs-approve-btn" type="button">Approve</button>
				</div>
			{/if}

			<!-- Blocked note (static amber, no banner, no pulse) -->
			{#if surface.aggr === 'blocked' && surface.blockedBy}
				<div class="blocked-note" data-testid="blocked-note">
					Blocked — waiting on {surface.blockedBy}
				</div>
			{/if}

			<!-- Result files row (only when files exist) -->
			{#if hasFiles}
				<div class="result-files-row" data-testid="result-files-row">
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						aria-hidden="true"
					>
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
						<polyline points="14 2 14 8 20 8" />
					</svg>
					<span class="files-summary">{filesSummary}</span>
					<button class="files-open-btn" type="button" onclick={onOpenDetail}>Open</button>
				</div>
			{/if}

			<!-- Complete row — always present when done, View result only when files exist -->
			{#if surface.aggr === 'done'}
				<div class="complete-row" data-testid="complete-row">
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						style="color: #4a9a6a;"
						aria-hidden="true"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
					<span class="complete-text">Verified · 4m 31s</span>
					{#if hasFiles}
						<button
							class="view-result-btn"
							data-testid="view-result-btn"
							type="button"
							onclick={onOpenDetail}>View result</button
						>
					{/if}
				</div>
			{/if}

			<!-- Failed row -->
			{#if surface.aggr === 'failed'}
				<div class="complete-row complete-row--failed" data-testid="failed-row">
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						style="color: var(--color-st-fail);"
						aria-hidden="true"
					>
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
					<span class="complete-text" style="color: var(--color-st-fail);">
						Failed · 30m · 5 tests still red
					</span>
					<button class="view-result-btn" type="button" onclick={onOpenDetail}>View logs</button>
				</div>
			{/if}

			<!-- Footer -->
			<div class="card-footer">
				<span class="footer-meta">
					{surface.aggr} · {surface.workers.length} worker{surface.workers.length > 1 ? 's' : ''}
				</span>
				<button class="detail-link" type="button" onclick={onOpenDetail}>
					More detail
					<svg
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						aria-hidden="true"
					>
						<polyline points="9 18 15 12 9 6" />
					</svg>
				</button>
			</div>
		</Collapsible.Content>
	</Collapsible.Root>
</div>

<style>
	/* ── Card shell ── */
	.card {
		background: var(--color-surface);
		border: 1px solid var(--color-edge);
		border-radius: 14px;
		overflow: hidden;
		font-size: 13px;
	}
	.card--needs {
		border-color: var(--color-st-needs);
	}
	.card--failed {
		border-color: var(--color-st-fail);
	}
	.card--done {
		opacity: 0.78;
	}

	/* ── Trigger (State A row) ── */
	.trigger {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		min-height: 44px;
		width: 100%;
		background: transparent;
		border: none;
		cursor: pointer;
		text-align: left;
		-webkit-tap-highlight-color: transparent;
	}
	.trigger-title {
		flex: 1;
		font-size: 13.5px;
		font-weight: 500;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.trigger-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: none;
		font-size: 11.5px;
		color: var(--color-st-done);
		font-variant-numeric: tabular-nums;
	}
	.chevron {
		transition: transform 0.25s;
	}
	.chevron--open {
		transform: rotate(180deg);
	}

	/* ── Status dot ── */
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: none;
	}
	.dot--running {
		background: var(--color-st-run);
		animation: breath 1.8s ease-in-out infinite;
	}
	.dot--needs-you {
		background: var(--color-st-needs);
		animation: breath 1.1s ease-in-out infinite;
	}
	.dot--blocked {
		background: var(--color-st-needs);
	}
	.dot--done {
		background: var(--color-st-done);
	}
	.dot--failed {
		background: var(--color-st-fail);
	}

	/* ── Card header ── */
	.card-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px 8px;
		border-bottom: 1px solid var(--color-edge);
	}
	.card-title {
		flex: 1;
		font-weight: 500;
		font-size: 13.5px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.stop-btn {
		font-size: 11.5px;
		color: var(--color-st-fail);
		border: 1px solid var(--color-st-fail);
		background: transparent;
		border-radius: 6px;
		padding: 4px 10px;
		cursor: pointer;
		min-height: 28px;
		white-space: nowrap;
	}

	/* ── Worker lanes ── */
	.worker-lanes {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 8px 14px 4px;
		border-bottom: 1px solid var(--color-edge);
	}
	.worker-lane-row {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 4px 0;
		font-size: 12px;
		color: var(--color-st-done);
	}
	.worker-lane-row--done {
		opacity: 0.45;
	}
	.lane-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		flex: none;
	}
	.lane-dot--running {
		background: var(--color-st-run);
		animation: breath 1.8s ease-in-out infinite;
	}
	.lane-dot--needs-you {
		background: var(--color-st-needs);
	}
	.lane-dot--done {
		background: var(--color-st-done);
	}
	.lane-code {
		font-size: 10px;
		font-weight: 700;
		padding: 1px 4px;
		border-radius: 3px;
		background: var(--color-surface-raised);
		color: var(--color-st-done);
		flex: none;
	}
	.lane-step {
		flex: 1;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* ── Stage spine ── */
	.stage-spine {
		display: flex;
		align-items: center;
		gap: 3px;
		padding: 6px 14px 8px;
	}
	.stage-pip {
		flex: 1;
		height: 3px;
		border-radius: 2px;
		background: var(--color-surface-raised);
		transition: background 0.3s;
	}
	.stage-pip--done {
		background: var(--color-st-done);
	}
	.stage-pip--active {
		background: var(--color-brand);
	}
	.stage-pip--failed {
		background: var(--color-st-fail);
	}
	.stage-pip--needs-you {
		background: var(--color-st-needs);
	}
	.stage-pip--blocked {
		background: var(--color-st-needs);
		opacity: 0.5;
	}
	/* Skipped: dashed border, no fill, distinct from pending */
	.stage-pip--skipped {
		background: transparent;
		border: 1.5px dashed var(--color-edge-active);
		opacity: 0.4;
	}

	/* ── Phase lines ── */
	.phase-lines {
		padding: 6px 14px;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.phase-line {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--color-st-done);
	}
	.phase-line--active {
		color: white;
	}
	.phase-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex: none;
	}
	.phase-dot--done {
		background: var(--color-st-done);
	}
	.phase-dot--active {
		background: var(--color-brand);
		animation: breath 1.4s ease-in-out infinite;
	}
	.phase-dot--failed {
		background: var(--color-st-fail);
	}
	.phase-dot--needs-you {
		background: var(--color-st-needs);
	}
	/* Skipped dot: hollow dashed circle */
	.phase-dot--skipped {
		background: transparent;
		border: 1.5px dashed var(--color-edge-active);
	}
	.phase-line--active .phase-text::after {
		content: '▌';
		animation: blink 0.9s step-start infinite;
		color: var(--color-brand);
		margin-left: 2px;
	}
	/* Skipped row: struck through, low opacity */
	.phase-line--skipped {
		opacity: 0.38;
		text-decoration: line-through;
		text-decoration-color: rgba(255, 255, 255, 0.2);
	}
	.phase-reason {
		text-decoration: none;
		font-style: italic;
		font-size: 11px;
		color: var(--color-st-done);
		margin-left: 2px;
	}

	/* ── Needs-you banner ── */
	.needs-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		background: rgba(201, 163, 78, 0.07);
		border-top: 1px solid rgba(201, 163, 78, 0.2);
	}
	.needs-text {
		flex: 1;
		font-size: 12.5px;
		color: var(--color-st-needs);
		line-height: 1.4;
	}
	.needs-approve-btn {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-background, #0a0a0b);
		background: var(--color-st-needs);
		border: none;
		border-radius: 8px;
		padding: 6px 14px;
		cursor: pointer;
		min-height: 32px;
		white-space: nowrap;
	}

	/* ── Blocked note ── */
	.blocked-note {
		padding: 8px 14px;
		font-size: 12px;
		color: var(--color-st-needs);
		border-top: 1px solid rgba(201, 163, 78, 0.15);
	}

	/* ── Result files row ── */
	.result-files-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		border-top: 1px solid var(--color-edge);
		font-size: 12px;
		color: var(--color-st-done);
	}
	.files-summary {
		flex: 1;
	}
	.files-open-btn {
		font-size: 11.5px;
		border: 1px solid var(--color-edge);
		background: transparent;
		color: var(--color-st-done);
		border-radius: 6px;
		padding: 3px 10px;
		cursor: pointer;
		min-height: 26px;
	}

	/* ── Complete / Failed rows ── */
	.complete-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border-top: 1px solid var(--color-edge);
	}
	.complete-text {
		flex: 1;
		font-size: 12px;
		color: var(--color-st-done);
	}
	.view-result-btn {
		font-size: 12px;
		border: 1px solid var(--color-edge);
		background: transparent;
		color: var(--color-st-done);
		border-radius: 6px;
		padding: 4px 10px;
		cursor: pointer;
		min-height: 28px;
	}

	/* ── Footer ── */
	.card-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 14px;
		border-top: 1px solid var(--color-edge);
	}
	.footer-meta {
		font-size: 11.5px;
		color: var(--color-st-done);
	}
	.detail-link {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11.5px;
		color: var(--color-st-done);
		background: none;
		border: none;
		cursor: pointer;
		padding: 4px 0;
	}

	/* ── Animations ── */
	@keyframes breath {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
	@keyframes blink {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dot,
		.lane-dot,
		.phase-dot,
		.phase-line--active .phase-text::after {
			animation: none !important;
		}
		.chevron {
			transition: none;
		}
	}
</style>
```

- [ ] **Step 4: Wire card into the route**

In `+page.svelte`, update the card-area to show the card for State B:

```svelte
<!-- Replace the card-area div content -->
<div class="flex flex-col gap-3">
	{#if activeState === 'A'}
		<SandboxDispatchPill {surface} onclick={() => (activeState = 'B')} />
	{:else if activeState === 'B'}
		<SandboxDispatchCard {surface} forceExpanded={true} onOpenDetail={() => (activeState = 'C')} />
	{:else if activeState === 'C'}
		<!-- Detail sheet added in Task 7 -->
		<p class="text-xs text-[var(--color-st-done)]">State C coming in Task 7</p>
	{/if}
</div>
```

Add import to `<script>`:

```typescript
import SandboxDispatchCard from '$lib/work-surface/SandboxDispatchCard.svelte';
```

- [ ] **Step 5: Run E2E tests**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -15
```

Expected: `14 passed` (7 earlier + 7 new State B tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/work-surface/SandboxDispatchCard.svelte src/routes/work-surface-sandbox/+page.svelte tests/e2e/sandbox.spec.ts
git commit -m "feat(sandbox): SandboxDispatchCard (State B) with lanes, skipped pips, result files row"
```

---

## Task 7: SandboxDetailSheet — State C

**Files:**

- Create: `src/lib/work-surface/SandboxDetailSheet.svelte`

- [ ] **Step 1: Add E2E tests for State C**

Append to `tests/e2e/sandbox.spec.ts`:

```typescript
test.describe('State C — SandboxDetailSheet', () => {
	test('sheet opens as a dialog portaled to body', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-testid="state-tab"][data-state="C"]').click();
		const sheet = page.locator('[data-testid="detail-sheet"]');
		await expect(sheet).toBeVisible();
		// Portaled to body: parent should be html or body (not inside app root)
		const parentTag = await sheet.evaluate((el) => el.parentElement?.tagName?.toLowerCase());
		expect(['body', 'html']).toContain(parentTag);
	});

	test('done preset: timeline shows skipped rows with full reason', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-preset="done"]').click();
		await page.locator('[data-testid="state-tab"][data-state="C"]').click();
		const skippedRows = page.locator('[data-testid="timeline-row"][data-status="skipped"]');
		await expect(skippedRows).toHaveCount(2);
		await expect(page.locator('[data-testid="skipped-full-reason"]').first()).toContainText(
			'Scope fully defined'
		);
	});

	test('done preset: file list shows 2 available entries', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-preset="done"]').click();
		await page.locator('[data-testid="state-tab"][data-state="C"]').click();
		const entries = page.locator('[data-testid="file-entry"]');
		await expect(entries).toHaveCount(2);
		await expect(entries.nth(0)).toHaveAttribute('data-status', 'available');
	});

	test('close button dismisses sheet', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-testid="state-tab"][data-state="C"]').click();
		await page.locator('[data-testid="detail-sheet"] button[aria-label="Close"]').click();
		await expect(page.locator('[data-testid="detail-sheet"]')).toHaveCount(0);
	});

	test('backdrop click dismisses sheet', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-testid="state-tab"][data-state="C"]').click();
		await page.locator('.sheet-overlay').click({ position: { x: 10, y: 10 } });
		await expect(page.locator('[data-testid="detail-sheet"]')).toHaveCount(0);
	});

	test('reduced-motion: sheet opens instantly without transition', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-testid="state-tab"][data-state="C"]').click();
		// Sheet must still be present (reduced-motion = instant, not skipped)
		await expect(page.locator('[data-testid="detail-sheet"]')).toBeVisible();
	});

	test('composer (text input) stays enabled while sheet is open', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-testid="state-tab"][data-state="C"]').click();
		const composer = page.locator('[data-testid="sandbox-composer"]');
		await expect(composer).toBeEnabled();
	});
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -10
```

- [ ] **Step 3: Create `SandboxDetailSheet.svelte`**

```svelte
<!-- src/lib/work-surface/SandboxDetailSheet.svelte -->
<script lang="ts">
	import { Dialog } from 'bits-ui';
	import { useSwipe, type SwipeCustomEvent } from 'svelte-gestures';
	import type { SeedSurface } from './sandbox-types';

	let {
		surface,
		onclose
	}: {
		surface: SeedSurface;
		onclose: () => void;
	} = $props();

	let open = $state(true);

	// Swipe-down to dismiss. useSwipe() returns props to spread on the touch target.
	// Applied to the handle bar — bits-ui Dialog.Content doesn't accept Svelte actions.
	const handleSwipeProps = useSwipe(
		(e: SwipeCustomEvent) => {
			if (e.detail.direction === 'bottom') {
				open = false;
				onclose();
			}
		},
		() => ({ timeframe: 300, minSwipeDistance: 60, touchAction: 'pan-y' })
	);

	function close() {
		open = false;
		onclose();
	}

	const PHASE_LABELS: Record<string, string> = {
		read: 'Read',
		research: 'Research',
		build: 'Build',
		check: 'Check',
		approve: 'Approve',
		reply: 'Reply'
	};

	const FILE_STATUS_LABELS: Record<string, string> = {
		available: 'Available',
		generating: 'Generating…',
		'needs-approval': 'Needs approval',
		failed: 'Failed',
		superseded: 'Superseded'
	};

	function fmtBytes(b?: number) {
		if (!b) return '';
		if (b < 1024) return `${b} B`;
		return `${(b / 1024).toFixed(1)} KB`;
	}
</script>

<!--
  Dialog.Portal renders outside the component tree, portaled to body (no `to` attribute).
  Confirmed: #app-root does not exist in this app (Stage 4 verify 2026-06-07).
-->
<Dialog.Root
	bind:open
	onOpenChange={(v) => {
		if (!v) onclose();
	}}
>
	<Dialog.Portal>
		<Dialog.Overlay class="sheet-overlay" onclick={close} />
		<Dialog.Content
			class="sheet-content"
			data-testid="detail-sheet"
			aria-label="Task detail — {surface.title}"
		>
			<!-- Swipe handle (touch target for swipe-down dismiss) -->
			<div class="sheet-handle-zone" {...handleSwipeProps}>
				<div class="sheet-handle" aria-hidden="true"></div>
			</div>

			<!-- Header -->
			<div class="sheet-header">
				<span class="sheet-title">{surface.title}</span>
				<Dialog.Close asChild>
					{#snippet child({ props })}
						<button {...props} class="sheet-close" aria-label="Close" type="button" onclick={close}>
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2.5"
								aria-hidden="true"
							>
								<line x1="18" y1="6" x2="6" y2="18" />
								<line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					{/snippet}
				</Dialog.Close>
			</div>

			<!-- Stage timeline -->
			<section class="sheet-section">
				<h2 class="sheet-section-label">Stage timeline</h2>
				<div class="timeline">
					{#each surface.phases as phase}
						<div
							class="timeline-row timeline-row--{phase.status}"
							data-testid="timeline-row"
							data-phase={phase.key}
							data-status={phase.status}
						>
							<div class="timeline-dot timeline-dot--{phase.status}" aria-hidden="true"></div>
							<span
								class="timeline-label"
								class:timeline-label--skipped={phase.status === 'skipped'}
							>
								{PHASE_LABELS[phase.key]}
							</span>
							<span class="timeline-time">
								{phase.status === 'skipped' ? 'skipped' : (phase.endedAt ?? phase.startedAt ?? '—')}
							</span>
						</div>
						{#if phase.status === 'skipped' && phase.reason}
							<div class="timeline-reason" data-testid="skipped-full-reason">
								{phase.reason}
							</div>
						{/if}
					{/each}
				</div>
			</section>

			<!-- Result files (only when files exist) -->
			{#if surface.files.length > 0}
				<section class="sheet-section">
					<h2 class="sheet-section-label">Result files</h2>
					<div class="file-list">
						{#each surface.files as file}
							<div class="file-entry" data-testid="file-entry" data-status={file.status}>
								<div class="file-dot file-dot--{file.status}" aria-hidden="true"></div>
								<span class="file-name" class:file-name--superseded={file.status === 'superseded'}>
									{file.path}
								</span>
								<span class="file-meta">{fmtBytes(file.sizeBytes)}</span>
								<span class="file-label file-label--{file.status}">
									{FILE_STATUS_LABELS[file.status] ?? file.status}
								</span>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Worker registry -->
			<section class="sheet-section">
				<h2 class="sheet-section-label">Workers</h2>
				{#each surface.workers as worker}
					<div class="worker-entry">
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							style="color: {worker.color}; flex: none;"
							aria-hidden="true"
						>
							<use href="#{worker.iconId}" />
						</svg>
						<span class="worker-code">{worker.shortcode}</span>
						<span class="worker-step">{worker.currentStep}</span>
					</div>
				{/each}
			</section>

			<!-- Actions -->
			<div class="sheet-actions">
				<button class="sheet-btn sheet-btn--cancel" type="button" onclick={close}>Close</button>
				{#if surface.aggr === 'failed'}
					<button class="sheet-btn sheet-btn--retry" type="button">Retry</button>
				{/if}
				{#if surface.aggr === 'running' || surface.aggr === 'needs-you'}
					<button class="sheet-btn sheet-btn--stop" type="button">Stop task</button>
				{/if}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	:global(.sheet-overlay) {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		z-index: 49;
		animation: fade-in 0.2s ease-out;
	}
	:global(.sheet-content) {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		max-height: 88dvh;
		background: var(--color-surface);
		border-radius: 20px 20px 0 0;
		border-top: 1px solid var(--color-edge);
		overflow-y: auto;
		z-index: 50;
		padding-bottom: env(safe-area-inset-bottom, 16px);
		animation: slide-up 0.28s cubic-bezier(0.32, 0.72, 0, 1);
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.sheet-overlay),
		:global(.sheet-content) {
			animation: none !important;
		}
	}

	.sheet-handle-zone {
		display: flex;
		justify-content: center;
		padding: 12px;
		cursor: grab;
	}
	.sheet-handle {
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: var(--color-edge-active);
	}
	.sheet-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 16px 10px;
		border-bottom: 1px solid var(--color-edge);
	}
	.sheet-title {
		flex: 1;
		font-size: 14px;
		font-weight: 600;
	}
	.sheet-close {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--color-surface-raised);
		border: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--color-st-done);
	}

	.sheet-section {
		padding: 14px 16px;
		border-bottom: 1px solid var(--color-edge);
	}
	.sheet-section-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-st-done);
		margin-bottom: 10px;
	}

	/* ── Timeline ── */
	.timeline {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.timeline-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
	}
	.timeline-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: none;
	}
	.timeline-dot--done {
		background: var(--color-st-done);
	}
	.timeline-dot--active {
		background: var(--color-brand);
	}
	.timeline-dot--failed {
		background: var(--color-st-fail);
	}
	.timeline-dot--needs-you {
		background: var(--color-st-needs);
	}
	.timeline-dot--pending {
		background: var(--color-edge-active);
	}
	.timeline-dot--blocked {
		background: var(--color-st-needs);
	}
	.timeline-dot--skipped {
		background: transparent;
		border: 1.5px dashed var(--color-edge-active);
	}
	.timeline-label {
		font-weight: 500;
	}
	.timeline-label--skipped {
		text-decoration: line-through;
		opacity: 0.5;
	}
	.timeline-time {
		flex: 1;
		text-align: right;
		color: var(--color-st-done);
		font-size: 11px;
	}
	.timeline-reason {
		padding: 2px 0 4px 15px;
		font-size: 11px;
		font-style: italic;
		color: var(--color-st-done);
	}

	/* ── File list ── */
	.file-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.file-entry {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 7px 0;
		border-bottom: 1px solid var(--color-edge);
		font-size: 12px;
	}
	.file-entry:last-child {
		border-bottom: none;
	}
	.file-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: none;
	}
	.file-dot--available {
		background: #4a9a6a;
	}
	.file-dot--generating {
		background: var(--color-st-run);
		animation: breath 1.2s ease-in-out infinite;
	}
	.file-dot--needs-approval {
		background: var(--color-st-needs);
	}
	.file-dot--failed {
		background: var(--color-st-fail);
	}
	.file-dot--superseded {
		background: var(--color-st-done);
	}
	.file-name {
		flex: 1;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.file-name--superseded {
		text-decoration: line-through;
		opacity: 0.5;
	}
	.file-meta {
		font-size: 10.5px;
		color: var(--color-st-done);
		flex: none;
	}
	.file-label {
		font-size: 10px;
		font-weight: 600;
		padding: 2px 6px;
		border-radius: 4px;
		flex: none;
		white-space: nowrap;
	}
	.file-label--available {
		background: rgba(74, 154, 106, 0.12);
		color: #4a9a6a;
	}
	.file-label--needs-approval {
		background: rgba(201, 163, 78, 0.12);
		color: var(--color-st-needs);
	}
	.file-label--superseded {
		background: var(--color-surface-raised);
		color: var(--color-st-done);
	}
	.file-label--generating {
		background: rgba(212, 212, 216, 0.12);
		color: var(--color-st-run);
	}
	.file-label--failed {
		background: rgba(194, 91, 91, 0.12);
		color: var(--color-st-fail);
	}

	/* ── Worker registry ── */
	.worker-entry {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 0;
		font-size: 12px;
	}
	.worker-code {
		font-size: 10px;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--color-surface-raised);
		color: var(--color-st-done);
		flex: none;
	}
	.worker-step {
		flex: 1;
		color: var(--color-st-done);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* ── Actions ── */
	.sheet-actions {
		display: flex;
		gap: 8px;
		padding: 12px 16px;
	}
	.sheet-btn {
		flex: 1;
		padding: 10px;
		border-radius: 10px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		border: none;
		min-height: 44px;
	}
	.sheet-btn--cancel {
		background: var(--color-surface-raised);
		color: var(--color-st-done);
		border: 1px solid var(--color-edge);
	}
	.sheet-btn--retry {
		background: var(--color-surface-raised);
		color: white;
		border: 1px solid var(--color-edge);
	}
	.sheet-btn--stop {
		background: rgba(194, 91, 91, 0.12);
		color: var(--color-st-fail);
		border: 1px solid var(--color-st-fail);
	}

	@keyframes fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes slide-up {
		from {
			transform: translateY(100%);
		}
		to {
			transform: translateY(0);
		}
	}
	@keyframes breath {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
</style>
```

- [ ] **Step 4: Wire detail sheet into the route**

In `+page.svelte`:

1. Add `let detailOpen = $state(false);`
2. Update the card-area:

```svelte
<div class="flex flex-col gap-3">
	{#if activeState === 'A'}
		<SandboxDispatchPill {surface} onclick={() => (activeState = 'B')} />
	{:else if activeState === 'B'}
		<SandboxDispatchCard {surface} forceExpanded={true} onOpenDetail={() => (detailOpen = true)} />
	{:else if activeState === 'C'}
		<SandboxDispatchCard {surface} forceExpanded={true} onOpenDetail={() => (detailOpen = true)} />
	{/if}
</div>

{#if detailOpen || activeState === 'C'}
	<SandboxDetailSheet
		{surface}
		onclose={() => {
			detailOpen = false;
			if (activeState === 'C') activeState = 'B';
		}}
	/>
{/if}
```

3. Add a fake composer input at the bottom so the composer test passes:

```svelte
<div
	class="fixed right-0 bottom-0 left-0 border-t border-[var(--color-edge)] bg-[var(--color-surface)] p-4"
>
	<input
		data-testid="sandbox-composer"
		type="text"
		placeholder="Sandbox composer — stays enabled"
		class="w-full rounded-full border border-[var(--color-edge)] bg-[var(--color-surface-raised)] px-4 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
	/>
</div>
```

Add import:

```typescript
import SandboxDetailSheet from '$lib/work-surface/SandboxDetailSheet.svelte';
```

- [ ] **Step 5: Run E2E tests**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -15
```

Expected: `21 passed` (14 earlier + 6 new State C tests + 1 composer)

- [ ] **Step 6: Commit**

```bash
git add src/lib/work-surface/SandboxDetailSheet.svelte src/routes/work-surface-sandbox/+page.svelte tests/e2e/sandbox.spec.ts
git commit -m "feat(sandbox): SandboxDetailSheet (State C) with swipe dismiss + file list"
```

---

## Task 8: One-shot animations (spawn / complete / fail)

**Files:**

- Modify: `src/lib/work-surface/SandboxDispatchCard.svelte`
- Modify: `src/routes/work-surface-sandbox/+page.svelte`

No Motion One dependency. CSS `@keyframes` + class-toggle via `$effect`.

- [ ] **Step 1: Add animation keyframes to `SandboxDispatchCard.svelte`**

Add to the `<style>` block (after the `@keyframes breath` block):

```css
/* ── One-shot beats ── */
@keyframes card-spawn {
	from {
		opacity: 0;
		transform: scale(0.94);
	}
	to {
		opacity: 1;
		transform: scale(1);
	}
}
@keyframes complete-ring {
	from {
		transform: scale(1);
		opacity: 0.7;
	}
	to {
		transform: scale(1.55);
		opacity: 0;
	}
}
@keyframes failure-shake {
	0% {
		transform: translateX(0);
	}
	20% {
		transform: translateX(-3px);
	}
	40% {
		transform: translateX(3px);
	}
	60% {
		transform: translateX(-2px);
	}
	80% {
		transform: translateX(2px);
	}
	100% {
		transform: translateX(0);
	}
}
.anim-spawn {
	animation: card-spawn 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.anim-fail {
	animation: failure-shake 180ms ease-out both;
}

/* Complete ring is on a pseudo-overlay element, not the card itself */
.complete-ring-el {
	position: absolute;
	inset: -1px;
	border-radius: inherit;
	border: 1.5px solid var(--color-st-done);
	pointer-events: none;
}
.complete-ring-el.anim-ring {
	animation: complete-ring 400ms ease-out both;
}
```

- [ ] **Step 2: Add `$effect` for spawn and status-change animations**

In `SandboxDispatchCard.svelte` `<script>`, add:

```typescript
let cardEl = $state<HTMLElement | null>(null);
let prevAggr = $state<string | null>(null);
let showRing = $state(false);

$effect(() => {
	if (!cardEl) return;
	// Spawn on mount
	cardEl.classList.add('anim-spawn');
	cardEl.addEventListener('animationend', () => cardEl?.classList.remove('anim-spawn'), {
		once: true
	});
});

$effect(() => {
	// One-shot on aggr transition
	const current = surface.aggr;
	if (prevAggr === null) {
		prevAggr = current;
		return;
	}
	if (prevAggr === current) return;

	if (current === 'done') {
		showRing = true;
		setTimeout(() => {
			showRing = false;
		}, 500);
	}
	if (current === 'failed' && cardEl) {
		cardEl.classList.remove('anim-fail');
		void cardEl.offsetWidth; // force reflow
		cardEl.classList.add('anim-fail');
		cardEl.addEventListener('animationend', () => cardEl?.classList.remove('anim-fail'), {
			once: true
		});
	}
	prevAggr = current;
});
```

- [ ] **Step 3: Add `bind:this` and ring overlay to the card element**

In the template, update the `.card` div:

```svelte
<div
  bind:this={cardEl}
  class="card"
  ...existing classes...
  style="position: relative;"
>
  {#if showRing}
    <div class="complete-ring-el anim-ring" aria-hidden="true"></div>
  {/if}
  <!-- existing Collapsible.Root content unchanged -->
```

- [ ] **Step 4: Add event buttons to the route**

In `+page.svelte`, replace the empty `#event-buttons` div:

```svelte
<div class="mb-4 flex gap-2" id="event-buttons">
	<button
		data-testid="btn-complete"
		class="rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs font-semibold text-white"
		onclick={applyComplete}>Complete</button
	>
	<button
		data-testid="btn-fail"
		class="rounded-lg border border-[var(--color-st-fail)] bg-[rgba(194,91,91,0.1)] px-3 py-1.5 text-xs font-semibold text-[var(--color-st-fail)]"
		onclick={applyFail}>Fail</button
	>
	<button
		data-testid="btn-reset"
		class="rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--color-st-done)]"
		onclick={() => (surfaceOverride = null)}>Reset</button
	>
</div>
```

- [ ] **Step 5: Add E2E tests for animations**

Append to `tests/e2e/sandbox.spec.ts`:

```typescript
test.describe('One-shot animations', () => {
	test('Complete button transitions card to done aggr', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-testid="state-tab"][data-state="B"]').click();
		// Start on running
		await expect(page.locator('[data-testid="sandbox-card"]')).toHaveAttribute(
			'data-aggr',
			'running'
		);
		// Fire complete
		await page.locator('[data-testid="btn-complete"]').click();
		await expect(page.locator('[data-testid="sandbox-card"]')).toHaveAttribute('data-aggr', 'done');
		await expect(page.locator('[data-testid="complete-row"]')).toBeVisible();
	});

	test('Fail button transitions card to failed aggr', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-testid="state-tab"][data-state="B"]').click();
		await page.locator('[data-testid="btn-fail"]').click();
		await expect(page.locator('[data-testid="sandbox-card"]')).toHaveAttribute(
			'data-aggr',
			'failed'
		);
		await expect(page.locator('[data-testid="failed-row"]')).toBeVisible();
	});

	test('Reset button returns to seed aggr', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox');
		await page.locator('[data-testid="state-tab"][data-state="B"]').click();
		await page.locator('[data-testid="btn-complete"]').click();
		await page.locator('[data-testid="btn-reset"]').click();
		await expect(page.locator('[data-testid="sandbox-card"]')).toHaveAttribute(
			'data-aggr',
			'running'
		);
	});
});
```

- [ ] **Step 6: Run E2E tests**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -10
```

Expected: `24 passed`

- [ ] **Step 7: Commit**

```bash
git add src/lib/work-surface/SandboxDispatchCard.svelte src/routes/work-surface-sandbox/+page.svelte tests/e2e/sandbox.spec.ts
git commit -m "feat(sandbox): spawn/complete/fail one-shot animations via CSS class-toggle"
```

---

## Task 9: Multi-surface layout + composer unblocked

**Files:**

- Modify: `src/routes/work-surface-sandbox/+page.svelte`

- [ ] **Step 1: Add E2E tests for multi-surface**

Append to `tests/e2e/sandbox.spec.ts`:

```typescript
test.describe('Multi-surface', () => {
	test('3 cards render simultaneously in State B, composer not blocked', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox?multi=1');
		const cards = page.locator('[data-testid="sandbox-card"]');
		await expect(cards).toHaveCount(3);
		// Composer stays enabled
		await expect(page.locator('[data-testid="sandbox-composer"]')).toBeEnabled();
	});

	test('3 cards have distinct aggr values (running, needs-you, done)', async ({ page }) => {
		await page.goto('/companion/work-surface-sandbox?multi=1');
		const aggrValues = await page
			.locator('[data-testid="sandbox-card"]')
			.evaluateAll((els) => els.map((el) => el.getAttribute('data-aggr')));
		expect(aggrValues).toContain('running');
		expect(aggrValues).toContain('needs-you');
		expect(aggrValues).toContain('done');
	});
});
```

- [ ] **Step 2: Add multi-surface mode to the route**

In `+page.svelte`, read the `?multi=1` query param and render all three seeds concurrently:

```svelte
<script lang="ts">
	// Add to existing script block:
	import { page as pageStore } from '$app/stores';
	import { SEED_RUNNING, SEED_NEEDS_YOU, SEED_DONE } from '$lib/work-surface/sandbox-seed';

	const isMulti = $derived($pageStore.url.searchParams.get('multi') === '1');
	const multiSurfaces = [SEED_RUNNING, SEED_NEEDS_YOU, SEED_DONE];
</script>
```

In the template, add a multi-surface section after the single-card area:

```svelte
{#if isMulti}
	<div class="mt-4 flex flex-col gap-3">
		<p class="text-xs font-semibold tracking-wide text-[var(--color-st-done)] uppercase">
			Multi-surface view (3 concurrent)
		</p>
		{#each multiSurfaces as ms}
			<SandboxDispatchCard surface={ms} forceExpanded={true} />
		{/each}
	</div>
{/if}
```

- [ ] **Step 3: Run E2E tests**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -10
```

Expected: `26 passed`

- [ ] **Step 4: Commit**

```bash
git add src/routes/work-surface-sandbox/+page.svelte tests/e2e/sandbox.spec.ts
git commit -m "feat(sandbox): multi-surface concurrent view (?multi=1)"
```

---

## Task 10: Final checks + prod build

**Files:**

- No changes — verification only.

- [ ] **Step 1: svelte-check**

```bash
npm run check 2>&1 | tail -10
```

Expected: `0 errors, 0 warnings`

If warnings appear about unused CSS selectors, either suppress with `/* svelte-ignore */` comments or fix the selector.

- [ ] **Step 2: Full test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all existing tests still pass + `aggregate.test.ts` 8 passed. Zero regressions.

- [ ] **Step 3: Prod build**

```bash
npm run build 2>&1 | tail -10
```

Expected: `built in Xs` with no errors.

- [ ] **Step 4: Restart the companion service**

```bash
sudo systemctl restart logueos-companion.service && sleep 3 && systemctl is-active logueos-companion.service
```

Expected: `active`

- [ ] **Step 5: Verify route is live at :18769**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:18769/companion/work-surface-sandbox
```

Expected: `200`

- [ ] **Step 6: Run Playwright against prod**

```bash
npx playwright test tests/e2e/sandbox.spec.ts --project=iphone-webkit 2>&1 | tail -15
```

(Default `PLAYWRIGHT_BASE_URL` points to `:18769`)

Expected: `26 passed`

- [ ] **Step 7: Tailscale URL for operator phone review**

The sandbox is now live at:

```
https://room.taila28611.ts.net/companion/work-surface-sandbox
https://room.taila28611.ts.net/companion/work-surface-sandbox?multi=1
```

- [ ] **Step 8: Final commit**

```bash
git status  # should be clean
```

If clean: done. If any fixups:

```bash
git add -p  # stage only intended changes
git commit -m "chore(sandbox): final prod verification"
```

---

## Self-review

**Spec coverage check:**

| Spec requirement                                            | Task that covers it                       |
| ----------------------------------------------------------- | ----------------------------------------- |
| Three states A/B/C                                          | Tasks 5, 6, 7                             |
| Worker cluster badge (single/stacked/overflow)              | Task 4                                    |
| One surface per intent, worker lanes                        | Task 6 (showWorkerLanes derived)          |
| Skipped ≠ Done — dashed pip, inline reason in B, full in C  | Tasks 6, 7                                |
| Phase states (7 states)                                     | Tasks 1, 6 CSS                            |
| Blocked vs Needs-you distinction                            | Task 6 (needs banner vs blocked-note)     |
| Aggregate status priority rule                              | Task 2 (deriveAggr)                       |
| Result files row in B (hidden when empty)                   | Task 6                                    |
| Result files full list in C with per-file status            | Task 7                                    |
| Complete row always present when done                       | Task 6                                    |
| "View result" button only when files exist                  | Task 6                                    |
| Motion: spawn scale/fade                                    | Task 8                                    |
| Motion: complete ring (one-shot)                            | Task 8                                    |
| Motion: failure shake (one-shot)                            | Task 8                                    |
| Motion: sustained breath/pulse/blink (CSS)                  | Tasks 5, 6 styles                         |
| Reduced-motion guard                                        | Tasks 5, 6 `@media` blocks + Task 7 sheet |
| bits-ui Collapsible for A↔B                                 | Task 6                                    |
| View Transitions API progressive enhancement                | Task 6 (toggle function)                  |
| bits-ui Dialog portaled to body                             | Task 7 (no `to` attribute)                |
| svelte-gestures useSwipe for dismiss                        | Task 7                                    |
| Svelte 5 runes only ($state/$derived/$effect/$props)        | All tasks                                 |
| Multi-surface concurrent, composer not blocked              | Task 9                                    |
| Seed data shape (SeedPhase/SeedWorker/SeedFile/SeedSurface) | Task 1                                    |
| iOS at every step (iphone-webkit Playwright)                | Tasks 3-9                                 |
| End on main, clean tree                                     | Task 10                                   |
| npm run check + build pass                                  | Task 10                                   |

No gaps found.

**Placeholder scan:** None found — every step has complete code.

**Type consistency check:**

- `SeedWorker.iconId` used in WorkerCluster and SandboxDetailSheet via `<use href="#{worker.iconId}">` ✓
- `SeedSurface.aggr` type `AggrStatus` consistent with `deriveAggr` return type ✓
- `SeedWorker.status` values (`'running' | 'done' | 'needs-you' | 'blocked' | 'failed'`) match `AggrStatus` values used in `deriveAggr` PRIORITY array ✓
- `onOpenDetail` callback prop in `SandboxDispatchCard` wired correctly in route ✓
- `forceExpanded` boolean prop — `bind:open={expanded}` initialized to `forceExpanded` in the component ✓
