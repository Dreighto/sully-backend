<script lang="ts">
	import { running, needsYou, done } from '$lib/data/surfaces.svelte';
	import type { Surface } from '$lib/types/workSurface';
	import WorkSurfaceCard from './WorkSurfaceCard.svelte';

	// Re-read the module getters reactively (they were exported as functions
	// because Svelte 5 forbids exporting $derived from a module).
	const runningList = $derived(running());
	const needsYouList = $derived(needsYou());
	const doneList = $derived(done());

	let expandedSurfaceId: string | null = $state(null);
	let isDockCollapsed: boolean = $state(true); // Start collapsed by default

	function toggleExpand(id: string) {
		expandedSurfaceId = expandedSurfaceId === id ? null : id;
	}

	function toggleDock() {
		isDockCollapsed = !isDockCollapsed;
		if (isDockCollapsed) {
			expandedSurfaceId = null; // Collapse any open card when collapsing the dock
		}
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

<div
	class="
		fixed top-0 right-0 bottom-0 z-50
		flex w-64 flex-col bg-card/80
		p-2 text-foreground
		backdrop-blur-sm
		transition-all duration-300
		ease-in-out md:w-80 lg:w-96
		{isDockCollapsed ? 'translate-x-full' : ''}
	"
>
	<button
		class="
			absolute top-1/2 -left-12 flex
			h-16 w-12
			-translate-y-1/2
			flex-col items-center
			justify-center rounded-l-lg bg-card/80 text-center text-sm
			font-bold text-foreground backdrop-blur-sm
		"
		onclick={toggleDock}
	>
		<span class="text-lg">{isDockCollapsed ? '‹' : '›'}</span>
		{#if isDockCollapsed}
			<span class="text-xs leading-none font-semibold"
				>R:{runningList.length} N:{needsYouList.length}</span
			>
		{/if}
	</button>

	{#if !isDockCollapsed}
		<div class="flex-none border-b border-border pb-2">
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

		<div class="-mr-2 flex-auto overflow-y-auto pr-2">
			<!-- Running Tasks -->
			{#if runningList.length > 0}
				<h3 class="mt-4 mb-2 text-sm font-semibold text-[--color-st-run]">Running</h3>
				{#each runningList as surface (surface.surfaceId)}
					<div
						class="
							mb-2 cursor-pointer rounded-lg border
							border-border bg-surface/50 p-2
							{expandedSurfaceId === surface.surfaceId ? 'border-[--color-brand]' : ''}
						"
						role="button"
						tabindex={0}
						onclick={() => toggleExpand(surface.surfaceId)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								toggleExpand(surface.surfaceId);
							}
						}}
					>
						<div class="flex items-center gap-2 text-sm font-medium">
							<span class="h-2 w-2 rounded-full {getStatusDotColor(surface.status)}"></span>
							<span class="flex-none font-mono text-xs text-[--color-brand]">
								{surface.task.workers[0]?.shortCode || 'SYS'}
							</span>
							<span class="flex-grow truncate">{surface.title}</span>
							<span class="flex-none text-xs text-muted-foreground">
								{surface.task.stage}
							</span>
						</div>
						{#if expandedSurfaceId === surface.surfaceId}
							<div class="-mx-2 mt-2 -mb-2">
								<WorkSurfaceCard footprint="expanded" task={surface.task} />
							</div>
						{/if}
					</div>
				{/each}
			{/if}

			<!-- Needs You Tasks -->
			{#if needsYouList.length > 0}
				<h3 class="mt-4 mb-2 text-sm font-semibold text-[--color-st-needs]">Needs You</h3>
				{#each needsYouList as surface (surface.surfaceId)}
					<div
						class="
							mb-2 cursor-pointer rounded-lg border
							border-border bg-surface/50 p-2
							{expandedSurfaceId === surface.surfaceId ? 'border-[--color-brand]' : ''}
						"
						role="button"
						tabindex={0}
						onclick={() => toggleExpand(surface.surfaceId)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								toggleExpand(surface.surfaceId);
							}
						}}
					>
						<div class="flex items-center gap-2 text-sm font-medium">
							<span class="h-2 w-2 rounded-full {getStatusDotColor(surface.status)}"></span>
							<span class="flex-none font-mono text-xs text-[--color-brand]">
								{surface.task.workers[0]?.shortCode || 'SYS'}
							</span>
							<span class="flex-grow truncate">{surface.title}</span>
							<span class="flex-none text-xs text-muted-foreground">
								{surface.needs?.prompt || 'Action required'}
							</span>
						</div>
						{#if expandedSurfaceId === surface.surfaceId}
							<div class="-mx-2 mt-2 -mb-2">
								<WorkSurfaceCard footprint="expanded" task={surface.task} />
							</div>
						{/if}
					</div>
				{/each}
			{/if}

			<!-- Done Tasks -->
			{#if doneList.length > 0}
				<h3 class="mt-4 mb-2 text-sm font-semibold text-[--color-st-done]">Done</h3>
				{#each doneList as surface (surface.surfaceId)}
					<div
						class="
							mb-2 cursor-pointer rounded-lg border
							border-border bg-surface/50 p-2
							{expandedSurfaceId === surface.surfaceId ? 'border-[--color-brand]' : ''}
						"
						role="button"
						tabindex={0}
						onclick={() => toggleExpand(surface.surfaceId)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								toggleExpand(surface.surfaceId);
							}
						}}
					>
						<div class="flex items-center gap-2 text-sm font-medium">
							<span class="h-2 w-2 rounded-full {getStatusDotColor(surface.status)}"></span>
							<span class="flex-none font-mono text-xs text-[--color-brand]">
								{surface.task.workers[0]?.shortCode || 'SYS'}
							</span>
							<span class="flex-grow truncate">{surface.title}</span>
							<span class="flex-none text-xs text-muted-foreground">
								{new Date(surface.updatedAt).toLocaleTimeString()}
							</span>
						</div>
						{#if expandedSurfaceId === surface.surfaceId}
							<div class="-mx-2 mt-2 -mb-2">
								<WorkSurfaceCard footprint="expanded" task={surface.task} />
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>
