<script lang="ts">
	import WorkSurfaceDock from '$lib/components/WorkSurfaceDock.svelte';
	import { spawnSurface, attachToSurface, setStatus } from '$lib/data/surfaces.svelte';
	import { workSurfaceSeed, type WorkSurfaceTask } from '$lib/data/workSurfaceSeed';
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

<div class="h-screen w-full bg-[--color-neutral-90]">
	<h1 class="text-3xl font-bold text-[--color-neutral-10] p-4">Work Surface Dock Preview</h1>
	<p class="text-[--color-neutral-40] p-4">
		This is a preview page for the Work Surface Dock component.
		It shows seed data for Running, Needs You, and Done tasks.
	</p>
	<WorkSurfaceDock />
</div>
