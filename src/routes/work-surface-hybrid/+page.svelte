<!-- src/routes/work-surface-hybrid/+page.svelte -->
<script lang="ts">
	import { page } from '$app/state';
	import WorkerIconSprite from '$lib/components/WorkerIconSprite.svelte';
	import {
		ALL_SEEDS,
		SEED_RUNNING,
		SEED_NEEDS_YOU,
		SEED_DONE
	} from '$lib/work-surface/hybrid/sandbox-seed';
	import type { SeedSurface, SeedPhase } from '$lib/work-surface/hybrid/hybrid-types';
	import HybridDispatchPill from '$lib/work-surface/hybrid/HybridDispatchPill.svelte';
	import HybridDispatchCard from '$lib/work-surface/hybrid/HybridDispatchCard.svelte';
	import HybridDetailSheet from '$lib/work-surface/hybrid/HybridDetailSheet.svelte';
	import { deriveAggr } from '$lib/work-surface/hybrid/aggregate';

	type PresetKey = 'running' | 'needs-you' | 'done' | 'failed';
	type StateKey = 'A' | 'B' | 'C';

	let activePreset = $state<PresetKey>('running');
	let activeState = $state<StateKey>('A');
	let hydrated = $state(false);
	
	$effect(() => {
		hydrated = true;
	});

	let surfaceOverride = $state<SeedSurface | null>(null);
	let detailOpen = $state(false);

	const surface = $derived(surfaceOverride ?? (ALL_SEEDS[activePreset] as unknown as SeedSurface));
	const aggr = $derived(deriveAggr(surface.workers));

	function setPreset(p: PresetKey) {
		activePreset = p;
		surfaceOverride = null;
	}

	function applyComplete() {
		const base = ALL_SEEDS[activePreset] as unknown as SeedSurface;
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

	function failPhases(phases: SeedPhase[]): SeedPhase[] {
		let failIdx = phases.findIndex((p) => p.status === 'active' || p.status === 'needs-you');
		if (failIdx === -1) {
			for (let i = phases.length - 1; i >= 0; i--) {
				if (phases[i].status !== 'skipped') {
					failIdx = i;
					break;
				}
			}
		}
		return phases.map((p, i) => {
			if (p.status === 'skipped') return { ...p, status: 'skipped' as const };
			if (i < failIdx) return { ...p, status: 'done' as const, endedAt: p.endedAt ?? '—' };
			if (i === failIdx) return { ...p, status: 'failed' as const, endedAt: p.endedAt ?? '—' };
			return { ...p, status: 'pending' as const, startedAt: null, endedAt: null };
		});
	}

	function applyFail() {
		const base = ALL_SEEDS[activePreset] as unknown as SeedSurface;
		surfaceOverride = {
			...base,
			aggr: 'failed',
			elapsedDisplay: '✕ ' + base.elapsedDisplay,
			workers: base.workers.map((w) => ({
				...w,
				status: 'failed' as const,
				currentStep: 'Failed — see logs'
			})),
			phases: failPhases(base.phases)
		};
	}

	const isMulti = $derived(page.url.searchParams.get('multi') === '1');
	const multiSurfaces = [SEED_RUNNING, SEED_NEEDS_YOU, SEED_DONE] as unknown as SeedSurface[];

	const PRESETS: PresetKey[] = ['running', 'needs-you', 'done', 'failed'];
	const STATES: { key: StateKey; label: string }[] = [
		{ key: 'A', label: 'A · Compact' },
		{ key: 'B', label: 'B · Expanded' },
		{ key: 'C', label: 'C · Detail' }
	];
</script>

<svelte:head>
	<title>Work Surface Sandbox — Hybrid</title>
</svelte:head>
<WorkerIconSprite />

<main
	class="min-h-dvh bg-[var(--color-background)] font-sans text-[var(--color-text,#e8eaf0)]"
	data-testid="sandbox-root"
	data-hydrated={hydrated ? 'true' : 'false'}
>
	<div class="mx-auto max-w-[430px] p-4 pb-24">
		<h1 class="mb-0.5 text-lg font-semibold">Work Surface Sandbox</h1>
		<p class="mb-4 text-xs text-[var(--color-st-done)]">C+B Hybrid — Lean Structure, Polished Visuals</p>

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
					onclick={() => {
						activeState = key;
						if (key === 'C') detailOpen = true;
					}}>{label}</button
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

		<!-- Event buttons -->
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

		<!-- Card area -->
		<div class="flex flex-col gap-3" id="card-area">
			{#if activeState === 'A'}
				<HybridDispatchPill {surface} {aggr} expanded={false} onclick={() => (activeState = 'B')} />
			{:else}
				<HybridDispatchCard
					{surface}
					forceExpanded={true}
					onOpenDetail={() => (detailOpen = true)}
				/>
			{/if}
		</div>

		{#if detailOpen || activeState === 'C'}
			<HybridDetailSheet
				{surface}
				onclose={() => {
					detailOpen = false;
					if (activeState === 'C') activeState = 'B';
				}}
			/>
		{/if}

		<!-- Multi-surface view (?multi=1) -->
		{#if isMulti}
			<div class="mt-4 flex flex-col gap-3">
				<p class="text-xs font-semibold tracking-wide text-[var(--color-st-done)] uppercase">
					Multi-surface view (3 concurrent)
				</p>
				{#each multiSurfaces as ms}
					<HybridDispatchCard surface={ms} forceExpanded={true} />
				{/each}
			</div>
		{/if}
	</div>

	<!-- Fixed-bottom composer — NEVER disabled -->
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
</main>
