<script lang="ts">
	import type { Surface } from '$lib/types/workSurface';
	import type { ChatMessage } from '$lib/types/chat-ui';
	import { workerBrandColor } from '$lib/utils/workerVisual';
	import { compactGlanceTitle } from '$lib/utils/glanceText';
	import WorkerIconSprite from '$lib/components/WorkerIconSprite.svelte';
	import WorkSurfaceCard from '$lib/components/WorkSurfaceCard.svelte';
	import { Collapsible, Dialog } from 'bits-ui';
	import { ChevronDown } from 'lucide-svelte';
	import { useSwipe, type SwipeCustomEvent } from 'svelte-gestures';

	let {
		surface,
		message
	}: {
		surface: Surface;
		message: ChatMessage;
	} = $props();

	// State A <-> B (Expanded)
	let expanded = $state(false);

	// State B <-> C (Detail sheet)
	let detailOpen = $state(false);

	// Stage 3 — swipe-down to dismiss the State C sheet. svelte-gestures v5
	// uses the useSwipe() hook pattern (props spread on the target element),
	// not the older `use:swipe` action — bits-ui components don't accept
	// Svelte actions anyway, so we apply this to the swipe-handle wrapper div.
	const sheetSwipeProps = useSwipe(
		(e: SwipeCustomEvent) => {
			if (e.detail.direction === 'bottom') detailOpen = false;
		},
		() => ({ timeframe: 300, minSwipeDistance: 60, touchAction: 'pan-y' })
	);

	// Stage 3 — View Transitions wrap on the row→surface morph. Progressive
	// enhancement: Safari 18+ / iOS 18+ gets a browser-native shared-element
	// transition; older WebKit falls back to the bits-ui Collapsible default.
	// See [[ssr-hydration-cached-factory-trap]] for the SSR guard pattern.
	function toggleExpanded() {
		const next = !expanded;
		const doc = typeof document !== 'undefined' ? document : null;
		if (doc && 'startViewTransition' in doc) {
			(doc as Document & { startViewTransition: (cb: () => void) => unknown }).startViewTransition(
				() => {
					expanded = next;
				}
			);
		} else {
			expanded = next;
		}
	}

	const activeWorker = $derived(
		surface?.task?.workers?.find((w) => w.status === 'active') ||
			surface?.task?.workers?.find((w) => w.status === 'done') ||
			surface?.task?.workers?.[0]
	);

	const brandColor = $derived(
		activeWorker
			? workerBrandColor(activeWorker.identity, activeWorker.shortCode)
			: 'var(--color-st-run)'
	);

	function getWorkerIconName(identity?: string, shortCode?: string, role?: string) {
		const id = (identity || '').toLowerCase();
		const code = (shortCode || '').toUpperCase();
		if (id === 'claude-code' || code === 'CC') return 'icon-claude';
		if (id === 'antigravity' || code === 'AGY') return 'icon-antigravity';
		if (id === 'codex' || code === 'CDX') return 'icon-cdx';
		if (id === 'gemini' || code === 'GMI') return 'icon-gmi';
		if (id === 'deepseek' || code === 'DPSK') return 'icon-deepseek';
		if (id === 'cursor' || code === 'CUR') return 'icon-cursor';
		if (!role) return 'icon-system';
		switch (role) {
			case 'Research':
				return 'icon-claude';
			case 'Build':
				return 'icon-antigravity';
			case 'Review':
				return 'icon-cdx';
			case 'Memory':
			case 'Vision':
			case 'Voice':
			default:
				return 'icon-system';
		}
	}

	const iconName = $derived(
		activeWorker?.icon ||
			getWorkerIconName(activeWorker?.identity, activeWorker?.shortCode, activeWorker?.role)
	);

	const statusDotColor = $derived.by(() => {
		if (!surface) return 'bg-zinc-500';
		if (surface.status === 'idle') return 'bg-amber-400';
		if (surface.status === 'running') return 'bg-green-500';
		if (surface.status === 'needs-you') return 'bg-amber-500';
		if (surface.status === 'done') return 'bg-green-500';
		if (surface.status === 'failed') return 'bg-red-500';
		return 'bg-zinc-500';
	});

	const elapsedLabel = $derived.by(() => {
		const startStr = surface?.task?.startedAt;
		if (!startStr) return '';
		const start = Date.parse(startStr);
		if (isNaN(start)) return '';
		const end = surface.task.endedAt ? Date.parse(surface.task.endedAt) : Date.now();
		if (isNaN(end) || end < start) return '';
		const secs = Math.round((end - start) / 1000);
		if (secs < 60) return `${Math.max(secs, 1)}s`;
		const mins = Math.round(secs / 60);
		if (mins < 60) return `${mins}m`;
		const h = Math.floor(mins / 60);
		const m = mins % 60;
		return m ? `${h}h ${m}m` : `${h}h`;
	});

	const glanceTitleText = $derived(
		surface?.task?.title ? compactGlanceTitle(surface.task.title) : 'Dispatch task'
	);
</script>

<div style="display: none;" aria-hidden="true">
	<WorkerIconSprite />
</div>

<Collapsible.Root bind:open={expanded} class="w-full font-sans select-none">
	<!-- State A: Compact Pill -->
	<Collapsible.Trigger
		onclick={(e: MouseEvent) => {
			// View Transitions wrap. Stop bits-ui's own click-toggle so we don't
			// double-flip; toggleExpanded() drives the bound state.
			e.preventDefault();
			toggleExpanded();
		}}
		class="dispatch-card-trigger flex w-full items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-left transition-all duration-200 hover:bg-zinc-800/40 focus:ring-2 focus:ring-brand/40 focus:outline-none"
		style="--worker-color: {brandColor}; border-color: color-mix(in srgb, var(--worker-color) 20%, var(--color-border))"
	>
		<div class="flex min-w-0 items-center gap-2.5">
			<!-- Worker Brand Glyph -->
			<div
				class="flex h-6 w-6 items-center justify-center rounded-md border border-zinc-800/80 bg-zinc-950/60"
				style="color: var(--worker-color);"
			>
				<svg class="h-4 w-4" fill="currentColor">
					<use href="#{iconName}"></use>
				</svg>
			</div>

			<!-- Status Dot -->
			<span
				class="inline-block h-2 w-2 rounded-full {statusDotColor} shadow-[0_0_8px_currentColor]"
				style="color: {brandColor};"
			></span>

			<!-- Glance Title -->
			<span class="truncate text-sm font-medium text-zinc-100">{glanceTitleText}</span>
		</div>

		<div class="flex shrink-0 items-center gap-2">
			<!-- Elapsed Time -->
			{#if elapsedLabel}
				<span class="font-mono text-xs text-zinc-400">{elapsedLabel}</span>
			{/if}
			<!-- Chevron -->
			<ChevronDown
				size={16}
				class="text-zinc-500 transition-transform duration-200 {expanded ? 'rotate-180' : ''}"
			/>
		</div>
	</Collapsible.Trigger>

	<!-- State B: Expanded Content -->
	<Collapsible.Content class="dispatch-card-content mt-2 w-full">
		<div
			class="rounded-xl border bg-zinc-900/50 p-4 shadow-lg backdrop-blur-md"
			style="border-color: color-mix(in srgb, var(--worker-color) 20%, var(--color-border))"
		>
			<!-- Embed WorkSurfaceCard (consumes the task projection, not the surface wrapper) -->
			<WorkSurfaceCard task={surface.task} />

			<!-- "More detail" affordance -> State C -->
			<div class="mt-4 flex items-center justify-between border-t border-zinc-800/60 pt-3">
				<button
					type="button"
					onclick={() => {
						detailOpen = true;
					}}
					class="flex min-h-[44px] cursor-pointer items-center gap-1 font-sans text-xs text-[16px] font-semibold text-zinc-400 transition-colors hover:text-zinc-200 sm:min-h-0 sm:text-xs"
				>
					More detail ↗
				</button>
			</div>
		</div>
	</Collapsible.Content>
</Collapsible.Root>

<!-- State C: Detail sheet -->
<Dialog.Root bind:open={detailOpen}>
	<Dialog.Portal to="#app-root">
		<Dialog.Overlay
			class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-all duration-200"
		/>
		<Dialog.Content
			class="dispatch-card-sheet fixed right-0 bottom-0 left-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border-t border-zinc-800 bg-zinc-950 p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl transition-all duration-300 focus:outline-none"
		>
			<!-- Swipe-detection wrapper. svelte-gestures actions can't attach to
			     bits-ui components (no addAction on Svelte components), so the
			     drag handle's surrounding area is the gesture surface. -->
			<div class="-mx-6 -mt-6 px-6 pt-6" {...sheetSwipeProps}>
				<!-- Dialog Header / Drag Handle -->
				<div class="mx-auto mb-4 h-1.5 w-12 rounded-full bg-zinc-800"></div>
			</div>

			<Dialog.Title class="text-lg font-bold text-zinc-100">Detail View</Dialog.Title>
			<Dialog.Description class="mt-1 text-sm text-zinc-400">
				Raw logs and details for dispatch task.
			</Dialog.Description>

			<!-- Scrollable content area -->
			<div class="mt-4 flex-1 overflow-y-auto text-zinc-300">
				<!-- Placeholder empty content for now -->
				<div class="py-12 text-center text-sm text-zinc-500">No details available yet.</div>
			</div>

			<!-- Close Button -->
			<div class="mt-6 flex justify-end">
				<Dialog.Close
					class="min-h-[44px] rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-[16px] font-medium text-zinc-200 transition-all hover:bg-zinc-800 active:scale-95 sm:min-h-0 sm:text-sm"
				>
					Close
				</Dialog.Close>
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	/* Stage 3 — content-area animation hooks. bits-ui sets data-state on
	   Collapsible.Content + Dialog.Content; the animation is driven by that.
	   View Transitions API (Safari 18+/iOS 18+) wraps the toggle for a
	   shared-element morph; this is the fallback / overlay for older WebKit. */
	:global(.dispatch-card-content[data-state='open']) {
		animation: dispatch-card-slide-in 280ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	:global(.dispatch-card-content[data-state='closed']) {
		animation: dispatch-card-slide-out 200ms ease;
	}
	@keyframes dispatch-card-slide-in {
		from {
			opacity: 0;
			transform: translateY(-8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@keyframes dispatch-card-slide-out {
		from {
			opacity: 1;
			transform: translateY(0);
		}
		to {
			opacity: 0;
			transform: translateY(-4px);
		}
	}

	/* iOS bottom-sheet slide-up. transition-behavior + @starting-style let us
	   animate from display:none without JS (Safari 17.5+). */
	:global(.dispatch-card-sheet) {
		transition:
			opacity 280ms ease,
			transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
		transition-behavior: allow-discrete;
	}
	@starting-style {
		:global(.dispatch-card-sheet) {
			opacity: 0;
			transform: translateY(100%);
		}
	}

	/* Reduced-motion: short-circuit all animations to instant. */
	@media (prefers-reduced-motion: reduce) {
		:global(.dispatch-card-content),
		:global(.dispatch-card-sheet) {
			animation: none !important;
			transition: none !important;
		}
	}
</style>
