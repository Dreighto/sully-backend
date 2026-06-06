<script lang="ts">
	import { running, needsYou, done, type Surface } from '$lib/data/surfaces.svelte';
	import WorkSurfaceCard from './WorkSurfaceCard.svelte';

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
				return 'bg-[--color-neutral-30]'; // Default neutral for idle, though not a dock status
			default:
				return 'bg-[--color-neutral-30]';
		}
	}
</script>

<div
	class="
		fixed right-0 bottom-0 top-0 z-50
		w-64 md:w-80 lg:w-96 p-2
		bg-[--color-neutral-80]/80 backdrop-blur-sm
		text-[--color-neutral-10]
		flex flex-col
		transition-all duration-300 ease-in-out
		{isDockCollapsed ? 'translate-x-full' : ''}
	"
>
	<button
		class="
			absolute -left-12 top-1/2 -translate-y-1/2
			w-12 h-16
			rounded-l-lg
			bg-[--color-neutral-80]/80 backdrop-blur-sm
			flex flex-col items-center justify-center text-center
			text-[--color-neutral-10] text-sm font-bold
		"
		onclick={toggleDock}
	>
		<span class="text-lg">{isDockCollapsed ? '‹' : '›'}</span>
		{#if isDockCollapsed}
			<span class="text-xs font-semibold leading-none">R:{running.length} N:{needsYou.length}</span>
		{/if}
	</button>

	{#if !isDockCollapsed}
		<div class="flex-none pb-2 border-b border-[--color-neutral-60]">
			<h2 class="text-lg font-semibold">Work Surface Dock</h2>
			<div class="flex gap-4 text-sm mt-1">
				<div class="flex items-center gap-1">
					<span class="w-2 h-2 rounded-full bg-[--color-st-run]"></span>
					<span>Running {running.length}</span>
				</div>
				<div class="flex items-center gap-1">
					<span class="w-2 h-2 rounded-full bg-[--color-st-needs]"></span>
					<span>Needs You {needsYou.length}</span>
				</div>
				<div class="flex items-center gap-1">
					<span class="w-2 h-2 rounded-full bg-[--color-st-done]"></span>
					<span>Done {done.length}</span>
				</div>
			</div>
		</div>

		<div class="flex-auto overflow-y-auto pr-2 -mr-2">
			<!-- Running Tasks -->
			{#if running.length > 0}
				<h3 class="text-sm font-semibold mt-4 mb-2 text-[--color-st-run]">Running</h3>
				{#each running as surface (surface.surfaceId)}
					<div
						class="
							bg-[--color-neutral-90]/50 rounded-lg border border-[--color-neutral-70]
							mb-2 p-2 cursor-pointer
							{expandedSurfaceId === surface.surfaceId ? 'border-[--color-brand]' : ''}
						"
						onclick={() => toggleExpand(surface.surfaceId)}
					>
						<div class="flex items-center gap-2 text-sm font-medium">
							<span class="w-2 h-2 rounded-full {getStatusDotColor(surface.status)}"></span>
							<span class="flex-none text-[--color-brand] font-mono text-xs">
								{surface.task.workers[0]?.shortCode || 'SYS'}
							</span>
							<span class="flex-grow truncate">{surface.title}</span>
							<span class="flex-none text-xs text-[--color-neutral-40]">
								{surface.task.stage}
							</span>
						</div>
						{#if expandedSurfaceId === surface.surfaceId}
							<div class="mt-2 -mx-2 -mb-2">
								<WorkSurfaceCard footprint="expanded" task={surface.task} />
							</div>
						{/if}
					</div>
				{/each}
			{/if}

			<!-- Needs You Tasks -->
			{#if needsYou.length > 0}
				<h3 class="text-sm font-semibold mt-4 mb-2 text-[--color-st-needs]">Needs You</h3>
				{#each needsYou as surface (surface.surfaceId)}
					<div
						class="
							bg-[--color-neutral-90]/50 rounded-lg border border-[--color-neutral-70]
							mb-2 p-2 cursor-pointer
							{expandedSurfaceId === surface.surfaceId ? 'border-[--color-brand]' : ''}
						"
						onclick={() => toggleExpand(surface.surfaceId)}
					>
						<div class="flex items-center gap-2 text-sm font-medium">
							<span class="w-2 h-2 rounded-full {getStatusDotColor(surface.status)}"></span>
							<span class="flex-none text-[--color-brand] font-mono text-xs">
								{surface.task.workers[0]?.shortCode || 'SYS'}
							</span>
							<span class="flex-grow truncate">{surface.title}</span>
							<span class="flex-none text-xs text-[--color-neutral-40]">
								{surface.needs?.prompt || 'Action required'}
							</span>
						</div>
						{#if expandedSurfaceId === surface.surfaceId}
							<div class="mt-2 -mx-2 -mb-2">
								<WorkSurfaceCard footprint="expanded" task={surface.task} />
							</div>
						{/if}
					</div>
				{/each}
			{/if}

			<!-- Done Tasks -->
			{#if done.length > 0}
				<h3 class="text-sm font-semibold mt-4 mb-2 text-[--color-st-done]">Done</h3>
				{#each done as surface (surface.surfaceId)}
					<div
						class="
							bg-[--color-neutral-90]/50 rounded-lg border border-[--color-neutral-70]
							mb-2 p-2 cursor-pointer
							{expandedSurfaceId === surface.surfaceId ? 'border-[--color-brand]' : ''}
						"
						onclick={() => toggleExpand(surface.surfaceId)}
					>
						<div class="flex items-center gap-2 text-sm font-medium">
							<span class="w-2 h-2 rounded-full {getStatusDotColor(surface.status)}"></span>
							<span class="flex-none text-[--color-brand] font-mono text-xs">
								{surface.task.workers[0]?.shortCode || 'SYS'}
							</span>
							<span class="flex-grow truncate">{surface.title}</span>
							<span class="flex-none text-xs text-[--color-neutral-40]">
								{new Date(surface.updatedAt).toLocaleTimeString()}
							</span>
						</div>
						{#if expandedSurfaceId === surface.surfaceId}
							<div class="mt-2 -mx-2 -mb-2">
								<WorkSurfaceCard footprint="expanded" task={surface.task} />
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>
