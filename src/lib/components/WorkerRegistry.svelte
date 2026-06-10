<script lang="ts">
	import type { WorkSurfaceTask } from '$lib/types/workSurface';
	import {
		workerBrandColor,
		workerBreathDelay,
		workerBreathFinishing
	} from '$lib/utils/workerVisual';

	let { task }: { task: WorkSurfaceTask } = $props();

	const getStatusClass = (status: string) => {
		if (status === 'done') return 'bg-status-green/10 text-status-green border-status-green/20';
		if (status === 'failed') return 'bg-status-red/10 text-status-red border-status-red/20';
		if (status === 'queued' || status === 'idle')
			return 'bg-surface text-muted-foreground border-border';
		return 'worker-badge-active';
	};
</script>

<div class="workers-grid">
	{#each task.workers as worker, i (worker.identity)}
		<div
			class="worker-row"
			class:row-active={worker.status === 'active'}
			class:row-failed={worker.status === 'failed'}
			class:row-done={worker.status === 'done'}
			style:--worker-color={workerBrandColor(worker.identity, worker.shortCode)}
			style:--worker-breath-delay={workerBreathDelay(i)}
		>
			<div class="worker-left">
				<span
					class="worker-dot {worker.status === 'active'
						? 'worker-surface-dot-breath'
						: ''} {worker.status === 'active' && workerBreathFinishing(worker)
						? 'worker-surface-breath--finishing'
						: ''}"
				></span>
				<span class="worker-identity">{worker.shortCode}</span>
				<span class="worker-role">{worker.display} ({worker.role})</span>
			</div>
			<div class="flex items-center gap-2">
				{#if worker.step}
					<span class="worker-status">{worker.step}</span>
				{/if}
				{#if worker.lastFile}
					<span class="worker-status">({worker.lastFile.split('/').pop()})</span>
				{/if}
				<span class="worker-badge-pill {getStatusClass(worker.status)}">
					{worker.status}
				</span>
			</div>
		</div>
	{/each}
</div>

<style lang="postcss">
	@reference "../../app.css";
	.workers-grid {
		@apply flex flex-col gap-1.5;
	}

	.worker-row {
		@apply flex items-center justify-between rounded-[var(--r-xs)] border border-border bg-surface px-3 py-2 text-sm transition-colors;
	}

	.worker-row.row-active {
		border-left: 2px solid var(--worker-color);
		background: color-mix(in srgb, var(--worker-color) 12%, transparent);
		padding-left: 0.625rem;
	}
	.worker-row.row-failed {
		@apply border-l-2 border-status-red bg-status-red/10 pl-2.5;
	}
	.worker-row.row-done {
		@apply border-l-2 border-status-green/40 bg-status-green/5 pl-2.5;
	}

	.worker-left {
		@apply flex items-center gap-2;
	}

	.worker-dot {
		@apply h-1.5 w-1.5 flex-shrink-0 rounded-[var(--r-pill)];
		background-color: color-mix(in srgb, var(--worker-color) 40%, transparent);
	}
	.worker-row.row-active .worker-dot {
		background-color: var(--worker-color);
		box-shadow: 0 0 6px color-mix(in srgb, var(--worker-color) 55%, transparent);
	}
	.worker-row.row-failed .worker-dot {
		@apply bg-status-red;
		box-shadow: 0 0 6px color-mix(in srgb, var(--color-status-red) 55%, transparent);
	}
	.worker-row.row-done .worker-dot {
		@apply bg-status-green;
	}

	.worker-badge-pill.worker-badge-active {
		color: var(--worker-color);
		border: 1px solid color-mix(in srgb, var(--worker-color) 28%, transparent);
		background: color-mix(in srgb, var(--worker-color) 14%, transparent);
	}

	.worker-identity {
		@apply font-semibold;
		color: color-mix(in srgb, var(--worker-color) 88%, white);
	}

	.worker-role {
		@apply text-xs font-normal text-muted-foreground;
	}

	.worker-status {
		@apply text-xs text-muted-foreground;
	}

	.worker-badge-pill {
		@apply rounded-[var(--r-xs)] px-1.5 py-0.5 text-[9px] font-bold uppercase;
	}
</style>
