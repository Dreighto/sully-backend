<script lang="ts">
	import WorkSurfaceCard from './WorkSurfaceCard.svelte';
	import PhaseChecklist from './PhaseChecklist.svelte';
	import WorkerRegistry from './WorkerRegistry.svelte';
	import ProofCard from './ProofCard.svelte';
	import { running, needsYou, done } from '$lib/data/surfaces.svelte';
	import type { Surface } from '$lib/types/workSurface';
	import { slide } from 'svelte/transition';

	// Sheet accordion state — which sections are expanded. Default = all collapsed
	// (the glance layer = status + card top + graph + timeline only). Operator
	// taps to dig deeper; most visits end at glance.
	let openSections = $state<Set<string>>(new Set());
	function toggleSection(key: string) {
		if (openSections.has(key)) openSections.delete(key);
		else openSections.add(key);
		openSections = new Set(openSections); // re-trigger reactivity
	}

	// Svelte 5 $props with $bindable: parent controls mode/openSurfaceId, internal
	// transitions write back via the binding (so the preview's buttons drive us,
	// and our toggle/open/close transitions reflect upward).
	type Mode = 'badge' | 'rail' | 'sheet';
	let {
		mode = $bindable<Mode>('badge'),
		openSurfaceId = $bindable<string | null>(null)
	}: {
		mode?: Mode;
		openSurfaceId?: string | null;
	} = $props();

	// Re-read the module getters reactively (they were exported as functions
	// because Svelte 5 forbids exporting $derived from a module).
	const runningList = $derived(running());
	const needsYouList = $derived(needsYou());
	const doneList = $derived(done());

	// Badge/Rail toggle
	function toggleDockState() {
		if (mode === 'badge') {
			mode = 'rail';
		} else if (mode === 'rail') {
			mode = 'badge';
			openSurfaceId = null; // Close any open card when collapsing to badge
		}
	}

	// Rail/Sheet transitions
	function openSurfaceSheet(id: string) {
		openSurfaceId = id;
		mode = 'sheet';
	}

	function closeSurfaceSheet() {
		openSurfaceId = null;
		mode = 'rail';
	}

	// Helper for status dot color
	function getStatusDotColor(status: Surface['status']): string {
		switch (status) {
			case 'running':
				return 'bg-[--color-st-run]';
			case 'needs-you':
				return 'bg-[--color-st-needs]';
			case 'done':
				return 'bg-[--color-st-done]';
			case 'failed':
				return 'bg-[--color-st-fail]';
			case 'idle':
				return 'bg-[--color-st-done]'; // Default neutral for idle, though not a dock status
			default:
				return 'bg-[--color-st-done]';
		}
	}
</script>

<!-- Badge Mode -->
{#if mode === 'badge'}
	<div
		class="fixed right-0 bottom-0 z-50 p-4 pr-[max(env(safe-area-inset-right),1rem)] pb-[max(env(safe-area-inset-bottom),1rem)]"
	>
		<button
			class="active-trigger flex h-9 w-max items-center gap-2 rounded-full bg-card/80 px-3 py-1 text-sm font-semibold text-foreground shadow-lg backdrop-blur-sm"
			onclick={toggleDockState}
			aria-label="Open Work Surface Dock"
		>
			<span class="h-2 w-2 rounded-full bg-[--color-st-run]"></span>
			<span>▶ {runningList.length}</span>
			{#if needsYouList.length > 0}
				<span class="h-2 w-2 rounded-full bg-[--color-st-needs]"></span>
				<span>⏸ {needsYouList.length}</span>
			{/if}
		</button>
	</div>
{/if}

<!-- Rail Mode -->
{#if mode === 'rail'}
	<div
		class="fixed top-0 right-0 bottom-0 z-50
		flex w-full flex-col bg-card/80
		p-2 text-foreground
		backdrop-blur-sm
		transition-all duration-300
		ease-in-out md:w-80 lg:w-96
	"
	>
		<button
			class="
			active-trigger absolute top-1/2 -left-12
			flex h-16
			w-12
			-translate-y-1/2 flex-col
			items-center justify-center rounded-l-lg bg-card/80 text-center
			text-sm font-bold text-foreground backdrop-blur-sm
		"
			onclick={toggleDockState}
			aria-label="Collapse Work Surface Dock"
		>
			<span class="text-lg">›</span>
		</button>

		<div class="flex-none border-b border-border px-4 pt-4 pb-2">
			<h2 class="text-lg font-semibold">Work Surface Dock</h2>
			<div class="mt-1 flex gap-4 text-sm">
				<div class="flex items-center gap-1">
					<span class="h-2 w-2 rounded-full bg-[--color-st-run]"></span>
					<span>Running {runningList.length}</span>
				</div>
				<div class="flex items-center gap-1">
					<span class="h-2 w-2 rounded-full bg-[--color-st-needs]"></span>
					<span>Needs You {needsYouList.length}</span>
				</div>
				<div class="flex items-center gap-1">
					<span class="h-2 w-2 rounded-full bg-[--color-st-done]"></span>
					<span>Done {doneList.length}</span>
				</div>
			</div>
		</div>

		<div class="-mr-2 flex-auto overflow-y-auto px-4 pr-2">
			<!-- Running Tasks -->
			{#if runningList.length > 0}
				<h3 class="mt-4 mb-2 text-sm font-semibold text-[--color-st-run]">Running</h3>
				{#each runningList as surface (surface.surfaceId)}
					<button
						type="button"
						class="active-trigger mb-2 cursor-pointer rounded-lg border border-border bg-surface/50 p-2 w-full text-left"
						onclick={() => openSurfaceSheet(surface.surfaceId)}
					>
						<div
							class="flex items-center gap-2 overflow-hidden text-sm font-medium whitespace-nowrap"
						>
							<span class="h-2 w-2 rounded-full {getStatusDotColor(surface.status)} flex-none"
							></span>
							<span class="flex-none font-mono text-xs text-[--color-brand]">
								{surface.task.workers[0]?.shortCode || 'SYS'}
							</span>
							<span class="flex-grow truncate">{surface.title}</span>
							<span class="ml-auto flex-none text-xs text-muted-foreground">
								{surface.task.stage}
							</span>
						</div>
					</button>
				{/each}
			{/if}

			<!-- Needs You Tasks -->
			{#if needsYouList.length > 0}
				<h3 class="mt-4 mb-2 text-sm font-semibold text-[--color-st-needs]">Needs You</h3>
				{#each needsYouList as surface (surface.surfaceId)}
					<button
						type="button"
						class="active-trigger mb-2 cursor-pointer rounded-lg border border-border bg-surface/50 p-2 w-full text-left"
						onclick={() => openSurfaceSheet(surface.surfaceId)}
					>
						<div
							class="flex items-center gap-2 overflow-hidden text-sm font-medium whitespace-nowrap"
						>
							<span class="h-2 w-2 rounded-full {getStatusDotColor(surface.status)} flex-none"
							></span>
							<span class="flex-none font-mono text-xs text-[--color-brand]">
								{surface.task.workers[0]?.shortCode || 'SYS'}
							</span>
							<span class="flex-grow truncate">{surface.title}</span>
							<span class="ml-auto flex-none text-xs text-muted-foreground">
								{surface.needs?.prompt || 'Action required'}
							</span>
						</div>
					</button>
				{/each}
			{/if}

			<!-- Done Tasks -->
			{#if doneList.length > 0}
				<h3 class="mt-4 mb-2 text-sm font-semibold text-[--color-st-done]">Done</h3>
				{#each doneList as surface (surface.surfaceId)}
					<button
						type="button"
						class="active-trigger mb-2 cursor-pointer rounded-lg border border-border bg-surface/50 p-2 w-full text-left"
						onclick={() => openSurfaceSheet(surface.surfaceId)}
					>
						<div
							class="flex items-center gap-2 overflow-hidden text-sm font-medium whitespace-nowrap"
						>
							<span class="h-2 w-2 rounded-full {getStatusDotColor(surface.status)} flex-none"
							></span>
							<span class="flex-none font-mono text-xs text-[--color-brand]">
								{surface.task.workers[0]?.shortCode || 'SYS'}
							</span>
							<span class="flex-grow truncate">{surface.title}</span>
							<span class="ml-auto flex-none text-xs text-muted-foreground">
								{new Date(surface.updatedAt).toLocaleTimeString()}
							</span>
						</div>
					</button>
				{/each}
			{/if}
		</div>
	</div>
{/if}

<!-- Sheet Mode -->
{#if mode === 'sheet'}
	{@const currentSurface = [...runningList, ...needsYouList, ...doneList].find(
		(s) => s.surfaceId === openSurfaceId
	)}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
	>
		<!-- Tap-out overlay for desktop sheet -->
		<div
			class="absolute inset-0 z-0 hidden md:block"
			role="button"
			tabindex={0}
			onclick={closeSurfaceSheet}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					closeSurfaceSheet();
				}
			}}
			aria-label="Close Work Surface Sheet"
		></div>
		<div
			class="relative h-full w-full overflow-y-auto bg-card p-4
			md:h-[90vh] md:max-w-2xl md:rounded-lg md:shadow-xl
		"
			role="dialog"
			aria-modal="true"
		>
			<button
				class="active-trigger absolute top-4 right-4 z-10 rounded-full bg-card/80 p-2 text-foreground"
				onclick={closeSurfaceSheet}
				aria-label="Back to Work Surface Dock"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="lucide lucide-x"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg
				>
			</button>
			{#if currentSurface}
				<!-- Glance layer: card top + status + graph + timeline only. The
				     inline detail panels (phases/workers/proof) are suppressed and
				     surface below as collapsed accordions. -->
				<WorkSurfaceCard
					footprint="expanded"
					task={currentSurface.task}
					suppressInlinePanels={true}
				/>

				<!-- Detail accordions — default collapsed, expand on tap. -->
				<div class="mt-6 space-y-2">
					<!-- Routing Phases -->
					<button
						type="button"
						class="flex w-full items-center justify-between rounded-lg bg-surface/50 px-4 py-3 text-left text-sm hover:bg-surface min-h-[44px]"
						aria-expanded={openSections.has('phases')}
						onclick={() => toggleSection('phases')}
					>
						<span class="font-semibold text-foreground">
							{openSections.has('phases') ? '▾' : '▸'} Routing Phases ({currentSurface.task
								.stageProgress?.length ?? 0})
						</span>
						<span class="text-xs text-muted-foreground">{currentSurface.task.stage}</span>
					</button>
					{#if openSections.has('phases')}
						<div transition:slide={{ duration: 200 }} class="px-1 pb-2">
							<PhaseChecklist task={currentSurface.task} />
						</div>
					{/if}

					<!-- Worker Registry -->
					<button
						type="button"
						class="flex w-full items-center justify-between rounded-lg bg-surface/50 px-4 py-3 text-left text-sm hover:bg-surface min-h-[44px]"
						aria-expanded={openSections.has('workers')}
						onclick={() => toggleSection('workers')}
					>
						<span class="font-semibold text-foreground">
							{openSections.has('workers') ? '▾' : '▸'} Worker Registry ({currentSurface.task
								.workers?.length ?? 0})
						</span>
						<span class="text-xs text-muted-foreground">
							{currentSurface.task.workers?.[0]?.shortCode ?? '—'}
							{(currentSurface.task.workers?.length ?? 0) > 1
								? `+${(currentSurface.task.workers?.length ?? 1) - 1}`
								: ''}
						</span>
					</button>
					{#if openSections.has('workers')}
						<div transition:slide={{ duration: 200 }} class="px-1 pb-2">
							<WorkerRegistry task={currentSurface.task} />
						</div>
					{/if}

					<!-- Proof -->
					<button
						type="button"
						class="flex w-full items-center justify-between rounded-lg bg-surface/50 px-4 py-3 text-left text-sm hover:bg-surface min-h-[44px]"
						aria-expanded={openSections.has('proof')}
						onclick={() => toggleSection('proof')}
					>
						<span class="font-semibold text-foreground">
							{openSections.has('proof') ? '▾' : '▸'} Proof
						</span>
						<span class="text-xs text-muted-foreground">
							{currentSurface.task.proof?.verdict ?? 'pending'}
						</span>
					</button>
					{#if openSections.has('proof') && currentSurface.task.proof}
						<div transition:slide={{ duration: 200 }} class="px-1 pb-2">
							<ProofCard task={currentSurface.task} />
						</div>
					{/if}
				</div>
			{:else}
				<p class="text-muted-foreground">Surface not found or no surface selected.</p>
			{/if}
		</div>
	</div>
{/if}
