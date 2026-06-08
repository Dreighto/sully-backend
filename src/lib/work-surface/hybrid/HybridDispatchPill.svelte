<!-- src/lib/work-surface/hybrid/HybridDispatchPill.svelte -->
<script lang="ts">
	import type { SeedSurface, AggrStatus } from './hybrid-types';
	import HybridWorkerCluster from './HybridWorkerCluster.svelte';
	import { ChevronDown } from 'lucide-svelte';

	let {
		surface,
		expanded = false,
		aggr,
		onclick
	}: {
		surface: SeedSurface;
		expanded?: boolean;
		aggr: AggrStatus;
		onclick?: () => void;
	} = $props();

	const PHASE_LABELS: Record<string, string> = {
		read: 'Read',
		research: 'Research',
		build: 'Build',
		check: 'Check',
		approve: 'Approve',
		reply: 'Reply'
	};

	const glanceTitle = $derived.by(() => {
		const active = surface.phases.find((p) => p.status === 'active');
		if (active) return `${PHASE_LABELS[active.key]} — ${surface.title}`;
		const needs = surface.phases.find((p) => p.status === 'needs-you');
		if (needs) return `${PHASE_LABELS[needs.key]} — ${surface.title}`;
		return surface.title;
	});

	// CDX critical #4: the pill must NOT be a <button>. In the work-surface card
	// it's wrapped by bits-ui Collapsible.Trigger (already a <button>), so a
	// <button> here is a nested-interactive HTML violation that breaks tap /
	// keyboard / screen-reader on iOS. Render a plain <div>; only when used
	// stand-alone (an onclick is passed, e.g. the demo route) does it become an
	// interactive role=button with keyboard support.
	const interactive = $derived(typeof onclick === 'function');
	function onKey(e: KeyboardEvent) {
		if (!onclick) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onclick();
		}
	}
</script>

<!-- tabindex + role are co-set: both present only when interactive (onclick
	 passed). Svelte's static check can't see the correlation. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="pill"
	class:pill--needs={aggr === 'needs-you'}
	class:pill--failed={aggr === 'failed'}
	class:pill--done={aggr === 'done'}
	class:pill--stopped={aggr === 'stopped'}
	class:pill--blocked={aggr === 'blocked'}
	class:pill--running={aggr === 'running'}
	class:pill--interactive={interactive}
	data-testid="hybrid-pill"
	data-aggr={aggr}
	role={interactive ? 'button' : undefined}
	tabindex={interactive ? 0 : undefined}
	{onclick}
	onkeydown={interactive ? onKey : undefined}
>
	<HybridWorkerCluster workers={surface.workers} />

	<div class="dot dot--{aggr}" data-testid="status-dot" data-status={aggr} aria-hidden="true"></div>

	<span class="title">{glanceTitle}</span>

	<div class="meta" aria-label="Elapsed: {surface.elapsedDisplay}">
		<span class="elapsed">{surface.elapsedDisplay}</span>
		<span class="chevron" class:chevron--open={expanded}>
			<ChevronDown size={16} />
		</span>
	</div>
</div>

<style>
	.pill {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		min-height: 44px;
		width: 100%;
		max-width: 100%;
		min-width: 0;
		box-sizing: border-box;
		background: var(--color-surface);
		border: 1px solid var(--color-edge);
		border-radius: 12px;
		text-align: left;
		transition:
			border-color 0.2s,
			background 0.2s;
		-webkit-tap-highlight-color: transparent;
	}
	/* Only the stand-alone (onclick-bearing) pill shows a pointer; inside the
	   card the Collapsible.Trigger wrapper owns the cursor + click. */
	.pill--interactive {
		cursor: pointer;
	}
	.pill--interactive:hover {
		background: var(--color-surface-raised);
		border-color: var(--color-edge-active);
	}
	.pill--running {
		border-color: color-mix(in srgb, var(--color-st-run) 35%, var(--color-edge));
	}
	.pill--needs {
		border-color: var(--color-st-needs);
		animation: needs-border 1.1s ease-in-out infinite;
	}
	.pill--failed {
		border-color: var(--color-st-fail);
	}
	.pill--done {
		opacity: 0.72;
	}
	.pill--blocked {
		border-color: color-mix(in srgb, var(--color-st-needs) 50%, var(--color-edge));
	}
	/* Stopped = neutral terminal (operator chose to stop). Dimmed, NOT red. */
	.pill--stopped {
		opacity: 0.6;
		border-color: var(--color-edge);
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
	.dot--stopped {
		background: var(--color-edge-active);
	}

	.title {
		flex: 1 1 0;
		min-width: 0;
		font-size: 13.5px;
		font-weight: 500;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--color-text, #e8eaf0);
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
	.chevron {
		display: flex;
		transition: transform 0.25s;
		color: var(--color-st-done);
	}
	.chevron--open {
		transform: rotate(180deg);
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

	@keyframes needs-border {
		0%,
		100% {
			border-color: var(--color-st-needs);
		}
		50% {
			border-color: color-mix(in srgb, var(--color-st-needs) 45%, transparent);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dot,
		.pill--needs {
			animation: none !important;
		}
		.chevron {
			transition: none;
		}
	}
</style>
