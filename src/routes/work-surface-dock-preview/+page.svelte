<script lang="ts">
	import WorkSurfaceDock from '$lib/components/WorkSurfaceDock.svelte';
	import { spawnSurface, attachToSurface, setStatus } from '$lib/data/surfaces.svelte';
	import { workSurfaceSeed } from '$lib/data/workSurfaceSeed';
	import { onMount } from 'svelte';

	onMount(() => {
		// 1. Running surface (multi-worker)
		const runningTask = workSurfaceSeed['multi-worker'];
		const runningId = spawnSurface('preview-running-msg-id', runningTask);
		setStatus(runningId, 'running');

		// 2. Needs-you surface (based on waiting-approval)
		const needsYouTask = workSurfaceSeed['waiting-approval'];
		const needsYouId = spawnSurface('preview-needs-you-msg-id', needsYouTask);
		attachToSurface(needsYouId, {
			status: 'needs-you',
			needs: { kind: 'approval', prompt: 'Approve git push to production?' },
			// Ensure the underlying task state is also reflective of 'Waiting' for WorkSurfaceCard rendering
			task: { ...needsYouTask, state: 'Waiting', stage: 'Approve' }
		});

		// 3. Done surface (complete)
		const doneTask = workSurfaceSeed['complete'];
		const doneId = spawnSurface('preview-done-msg-id', doneTask);
		setStatus(doneId, 'done');
	});
</script>

<div class="flex min-h-screen w-full flex-col overflow-y-auto bg-background text-foreground">
	<div class="px-4 pt-6 pb-2">
		<h1 class="text-2xl font-bold">Work Surface Dock — Preview</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Seed: one Running (multi-worker), one Needs-you (approval), one Done. Tap a row to expand.
		</p>
	</div>
	<WorkSurfaceDock />
</div>
