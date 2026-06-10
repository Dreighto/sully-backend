<script lang="ts">
	import WorkSurfaceCard from '$lib/components/WorkSurfaceCard.svelte';
	import { createWorkSurfaceView } from '$lib/work-surface/view.svelte';
	import type { Surface } from '$lib/types/workSurface';
	import type { WorkSurfaceDockMode } from '$lib/work-surface/types';

	let {
		mode = $bindable<WorkSurfaceDockMode>('badge'),
		openSurfaceId = $bindable<string | null>(null),
		sheetReturnMode = $bindable<WorkSurfaceDockMode>('badge')
	}: {
		mode?: WorkSurfaceDockMode;
		openSurfaceId?: string | null;
		sheetReturnMode?: WorkSurfaceDockMode;
	} = $props();

	const view = createWorkSurfaceView(() => openSurfaceId);

	function toggleDockState() {
		if (mode === 'badge') {
			mode = 'rail';
		} else if (mode === 'rail') {
			mode = 'badge';
			openSurfaceId = null;
		}
	}

	function openSurfaceSheet(id: string) {
		openSurfaceId = id;
		sheetReturnMode = mode === 'inline' ? 'inline' : 'badge';
		mode = 'sheet';
	}

	function closeSurfaceSheet() {
		mode = sheetReturnMode;
		if (mode === 'badge') openSurfaceId = null;
	}

	function getStatusDotColor(status: Surface['status']): string {
		switch (status) {
			case 'running':
				return 'bg-st-run';
			case 'needs-you':
				return 'bg-st-needs';
			case 'done':
				return 'bg-st-done';
			case 'failed':
				return 'bg-st-fail';
			case 'idle':
				return 'bg-st-done';
			default:
				return 'bg-st-done';
		}
	}
</script>

<!-- Badge mode: pill above composer is the collapsed entry point. -->

{#if mode === 'rail'}
	<div
		class="fixed top-0 right-0 bottom-0 z-50
		flex w-full flex-col bg-card/80
		p-2 text-foreground
		backdrop-blur-sm
		transition-all duration-[var(--dur-slow)]
		ease-in-out md:w-80 lg:w-96
	"
	>
		<button
			class="
			active-trigger absolute top-1/2 -left-12
			flex h-16
			w-12
			-translate-y-1/2 flex-col
			items-center justify-center rounded-l-[var(--r-sm)] bg-card/80 text-center
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
					<span class="h-2 w-2 rounded-[var(--r-pill)] bg-st-run"></span>
					<span>Running {view.runningList.length}</span>
				</div>
				<div class="flex items-center gap-1">
					<span class="h-2 w-2 rounded-[var(--r-pill)] bg-st-needs"></span>
					<span>Needs You {view.needsYouList.length}</span>
				</div>
				<div class="flex items-center gap-1">
					<span class="h-2 w-2 rounded-[var(--r-pill)] bg-st-done"></span>
					<span>Done {view.doneList.length}</span>
				</div>
			</div>
		</div>

		<div class="-mr-2 flex-auto overflow-y-auto px-4 pr-2">
			{#if view.runningList.length > 0}
				<h3 class="mt-4 mb-2 text-sm font-semibold text-st-run">Running</h3>
				{#each view.runningList as surface (surface.surfaceId)}
					<button
						type="button"
						class="active-trigger mb-2 flex min-h-[44px] w-full cursor-pointer items-center rounded-[var(--r-sm)] border border-border bg-surface/50 p-2 text-left"
						onclick={() => openSurfaceSheet(surface.surfaceId)}
					>
						<div
							class="flex items-center gap-2 overflow-hidden text-sm font-medium whitespace-nowrap"
						>
							<span
								class="h-2 w-2 rounded-[var(--r-pill)] {getStatusDotColor(
									surface.status
								)} flex-none"
							></span>
							<span class="flex-none font-mono text-xs text-foreground">
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

			{#if view.needsYouList.length > 0}
				<h3 class="mt-4 mb-2 text-sm font-semibold text-st-needs">Needs You</h3>
				{#each view.needsYouList as surface (surface.surfaceId)}
					<button
						type="button"
						class="active-trigger mb-2 flex min-h-[44px] w-full cursor-pointer items-center rounded-[var(--r-sm)] border border-border bg-surface/50 p-2 text-left"
						onclick={() => openSurfaceSheet(surface.surfaceId)}
					>
						<div
							class="flex items-center gap-2 overflow-hidden text-sm font-medium whitespace-nowrap"
						>
							<span
								class="h-2 w-2 rounded-[var(--r-pill)] {getStatusDotColor(
									surface.status
								)} flex-none"
							></span>
							<span class="flex-none font-mono text-xs text-foreground">
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

			{#if view.doneList.length > 0}
				<h3 class="mt-4 mb-2 text-sm font-semibold text-st-done">Done</h3>
				{#each view.doneList as surface (surface.surfaceId)}
					<button
						type="button"
						class="active-trigger mb-2 flex min-h-[44px] w-full cursor-pointer items-center rounded-[var(--r-sm)] border border-border bg-surface/50 p-2 text-left"
						onclick={() => openSurfaceSheet(surface.surfaceId)}
					>
						<div
							class="flex items-center gap-2 overflow-hidden text-sm font-medium whitespace-nowrap"
						>
							<span
								class="h-2 w-2 rounded-[var(--r-pill)] {getStatusDotColor(
									surface.status
								)} flex-none"
							></span>
							<span class="flex-none font-mono text-xs text-foreground">
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

{#if mode === 'sheet'}
	{@const currentSurface = view.currentSurface}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
	>
		<div
			class="absolute inset-0 z-0"
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
			md:h-[90vh] md:max-w-2xl md:rounded-[var(--r-sm)] md:shadow-[var(--shadow-card)]
		"
			role="dialog"
			aria-modal="true"
		>
			<button
				class="active-trigger absolute top-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-[var(--r-pill)] bg-card/80 text-foreground"
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
				<WorkSurfaceCard footprint="expanded" task={currentSurface.task} />
			{:else}
				<p class="text-muted-foreground">Surface not found or no surface selected.</p>
			{/if}
		</div>
	</div>
{/if}
