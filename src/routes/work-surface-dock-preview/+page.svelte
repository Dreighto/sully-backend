<script lang="ts">
	import WorkSurfaceDock from '$lib/components/WorkSurfaceDock.svelte';
	import WorkSurfaceIndicator from '$lib/components/WorkSurfaceIndicator.svelte';
	import { spawnSurface, attachToSurface, setStatus } from '$lib/data/surfaces.svelte';
	import { workSurfaceSeed } from '$lib/data/workSurfaceSeed';
	import { onMount } from 'svelte';

	// Bind these into the dock so our buttons actually drive it.
	let dockMode = $state<'badge' | 'rail' | 'sheet'>('badge');
	let dockOpenSurfaceId = $state<string | null>(null);

	// Capture the real surfaceIds returned by spawnSurface so we can target the
	// right one when jumping straight into 'sheet' mode (the seed *message* id
	// is NOT the same as the *surface* id).
	let runningSurfaceId = $state<string | null>(null);
	let needsYouSurfaceId = $state<string | null>(null);
	let doneSurfaceId = $state<string | null>(null);

	function openSheetFor(id: string | null) {
		if (!id) return;
		dockOpenSurfaceId = id;
		dockMode = 'sheet';
	}

	onMount(() => {
		// 1. Running surface (multi-worker)
		const runningTask = workSurfaceSeed['multi-worker'];
		runningSurfaceId = spawnSurface('preview-running-msg-id', runningTask);
		setStatus(runningSurfaceId, 'running');

		// 2. Needs-you surface (based on waiting-approval)
		const needsYouTask = workSurfaceSeed['waiting-approval'];
		needsYouSurfaceId = spawnSurface('preview-needs-you-msg-id', needsYouTask);
		attachToSurface(needsYouSurfaceId, {
			status: 'needs-you',
			needs: { kind: 'approval', prompt: 'Approve git push to production?' },
			task: { ...needsYouTask, state: 'Waiting', stage: 'Approve' }
		});

		// 3. Done surface (complete)
		const doneTask = workSurfaceSeed['complete'];
		doneSurfaceId = spawnSurface('preview-done-msg-id', doneTask);
		setStatus(doneSurfaceId, 'done');
	});
</script>

<div class="flex min-h-screen w-full flex-col overflow-y-auto bg-background text-foreground">
	<div class="px-4 pt-6 pb-2">
		<h1 class="text-2xl font-bold">Work Surface Dock — Preview</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Seed: one Running (multi-worker), one Needs-you (approval), one Done.
		</p>

		<p class="mt-4 text-sm text-muted-foreground">
			↓ This is the composer indicator. It shows work-state. Tap it to jump to the
			most-important surface.
		</p>
		<div class="mt-2 flex flex-wrap gap-2">
			<WorkSurfaceIndicator bind:mode={dockMode} bind:openSurfaceId={dockOpenSurfaceId} />
		</div>

		<!-- Direct Sheet buttons (for manual demo) -->
		<div class="mt-4 flex flex-wrap gap-2">
			<button
				type="button"
				class="rounded-full border border-brand bg-brand/10 px-3 py-1.5 text-xs text-foreground hover:bg-brand/20"
				onclick={() => openSheetFor(runningSurfaceId)}>Sheet · Running</button
			>
			<button
				type="button"
				class="rounded-full border border-brand bg-brand/10 px-3 py-1.5 text-xs text-foreground hover:bg-brand/20"
				onclick={() => openSheetFor(needsYouSurfaceId)}>Sheet · Needs-you</button
			>
			<button
				type="button"
				class="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-card"
				onclick={() => openSheetFor(doneSurfaceId)}>Sheet · Done</button
			>
		</div>
	</div>
	<!-- The dock component for rendering rail/sheet views -->
	<WorkSurfaceDock bind:mode={dockMode} bind:openSurfaceId={dockOpenSurfaceId} />
</div>
