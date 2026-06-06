<script lang="ts">
	import { workSurfaceSeed, seedKeys } from '$lib/data/workSurfaceSeed';
	import StageTimeline from '$lib/components/StageTimeline.svelte'; // Keeping this import if other parts of the app might use it, but no longer directly rendered here
	import WorkSurfaceCard from '$lib/components/WorkSurfaceCard.svelte'; // New import

	let presetKey = $state(seedKeys[0]);
	let previewDispatchActive = $state(false);
	const task = $derived.by(() => {
		const baseTask = workSurfaceSeed[presetKey];
		return {
			...baseTask,
			routing: {
				...baseTask.routing,
				edges: baseTask.routing.edges.map((edge) => ({
					...edge,
					dispatchActive: previewDispatchActive,
					dispatch_active: previewDispatchActive
				}))
			}
		};
	});

	let footprint = $state<'collapsed' | 'compact' | 'expanded'>('compact');

	// Dummy action handlers for preview purposes
	function handleApprove() {
		console.log('Approve action triggered');
		// In a real app, this would dispatch to backend
	}
	function handleStop() {
		console.log('Stop action triggered');
		// In a real app, this would dispatch to backend
	}
	function handleRetry() {
		console.log('Retry action triggered');
		// In a real app, this would dispatch to backend
	}
</script>

<div
	class="flex min-h-screen flex-col items-center justify-start gap-4 overflow-y-auto bg-background p-4 py-8 font-sans text-foreground"
>
	<div class="w-full max-w-2xl space-y-6 rounded-lg border border-border bg-card p-6 shadow-xl">
		<h1 class="text-center text-2xl font-bold text-primary">Work Surface Preview</h1>

		<div class="control-group">
			<h3 class="mb-2 text-lg font-semibold text-white">Footprint State</h3>
			<div class="flex flex-wrap justify-center gap-2">
				{#each ['collapsed', 'compact', 'expanded'] as foot (foot)}
					<button
						type="button"
						class="rounded-md px-4 py-2 text-sm font-medium transition-colors"
						class:bg-brand={footprint === foot}
						class:text-white={footprint === foot}
						class:bg-surface={footprint !== foot}
						class:text-muted-foreground={footprint !== foot}
						onclick={() => (footprint = foot as typeof footprint)}
					>
						{foot.charAt(0).toUpperCase() + foot.slice(1)}
					</button>
				{/each}
			</div>
		</div>

		<div class="control-group">
			<h3 class="mb-2 text-lg font-semibold text-white">Event Simulation</h3>
			<div class="flex flex-wrap justify-center gap-2">
				<button
					type="button"
					class="rounded-md px-4 py-2 text-sm font-medium transition-colors"
					class:bg-brand={previewDispatchActive}
					class:text-white={previewDispatchActive}
					class:bg-surface={!previewDispatchActive}
					class:text-muted-foreground={!previewDispatchActive}
					onclick={() => (previewDispatchActive = !previewDispatchActive)}
				>
					{previewDispatchActive ? 'Stop Data Flow' : 'Trigger dispatch_started'}
				</button>
			</div>
		</div>

		<div class="control-group">
			<h3 class="mb-2 text-lg font-semibold text-white">Simulation Presets</h3>
			<div class="flex flex-wrap justify-center gap-2">
				{#each seedKeys as key (key)}
					<button
						type="button"
						class="rounded-md px-4 py-2 text-sm font-medium transition-colors"
						class:bg-brand={presetKey === key}
						class:text-white={presetKey === key}
						class:bg-surface={presetKey !== key}
						class:text-muted-foreground={presetKey !== key}
						onclick={() => (presetKey = key)}
					>
						{key
							.split('-')
							.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
							.join(' ')}
					</button>
				{/each}
			</div>
		</div>

		<!-- WorkSurfaceCard component now renders the task details -->
		<WorkSurfaceCard
			{task}
			{footprint}
			onapprove={handleApprove}
			onstop={handleStop}
			onretry={handleRetry}
		/>
	</div>
</div>

<style>
	/* Any specific styles for this preview page can go here if needed */
</style>
