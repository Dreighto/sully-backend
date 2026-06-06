<script lang="ts">
	import type { WorkSurfaceTask } from '$lib/types/workSurface';

	let { task }: { task: WorkSurfaceTask } = $props();

	// Map worker roles/statuses to Tailwind classes
	const getRoleClass = (role: string) => {
		switch (role) {
			case 'Research':
				return 'bg-status-blue/10 text-status-blue border-status-blue/20';
			case 'Build':
				return 'bg-brand/10 text-brand border-brand/20';
			case 'Review':
				return 'bg-status-purple/10 text-status-purple border-status-purple/20';
			case 'Vision': // Assuming Vision maps to Research for visual
			case 'Memory': // Assuming Memory maps to Research for visual
			case 'Voice': // Assuming Voice maps to Research for visual
				return 'bg-status-blue/10 text-status-blue border-status-blue/20';
			default:
				return 'bg-surface text-muted-foreground border-border';
		}
	};
	const getStatusClass = (status: string, role: string) => {
		if (status === 'done') return 'bg-status-green/10 text-status-green border-status-green/20';
		if (status === 'failed') return 'bg-status-red/10 text-status-red border-status-red/20';
		if (status === 'queued' || status === 'idle')
			return 'bg-surface text-muted-foreground border-border';
		// For 'active', use role color
		return getRoleClass(role);
	};
</script>

<div class="workers-grid">
	{#each task.workers as worker (worker.identity)}
		<div
			class="worker-row"
			class:row-active-highlight-researching={worker.role === 'Research' &&
				worker.status === 'active'}
			class:row-active-highlight-building={worker.role === 'Build' && worker.status === 'active'}
			class:row-active-highlight-verifying={worker.role === 'Review' && worker.status === 'active'}
			class:row-active-highlight-blocked={worker.status === 'failed'}
		>
			<div class="worker-left">
				<span
					class="worker-dot"
					class:row-active-highlight-researching={worker.role === 'Research' &&
						worker.status === 'active'}
					class:row-active-highlight-building={worker.role === 'Build' &&
						worker.status === 'active'}
					class:row-active-highlight-verifying={worker.role === 'Review' &&
						worker.status === 'active'}
					class:row-active-highlight-blocked={worker.status === 'failed'}
					class:complete={worker.status === 'done'}
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
				<span class="worker-badge-pill {getStatusClass(worker.status, worker.role)}">
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
		@apply flex justify-between items-center px-3 py-2 rounded-md border border-border bg-surface text-sm transition-colors;
	}

	.worker-row.row-active-highlight-researching {
		@apply bg-status-blue/10 border-l-2 border-status-blue pl-2.5; /* padding-left adjusted for border */
	}
	.worker-row.row-active-highlight-building {
		@apply bg-brand/10 border-l-2 border-brand pl-2.5;
	}
	.worker-row.row-active-highlight-verifying {
		@apply bg-status-purple/10 border-l-2 border-status-purple pl-2.5;
	}
	.worker-row.row-active-highlight-blocked {
		@apply bg-status-red/10 border-l-2 border-status-red pl-2.5;
	}

	.worker-left {
		@apply flex items-center gap-2;
	}

	.worker-dot {
		@apply w-1.5 h-1.5 rounded-full flex-shrink-0;
		background-color: rgb(255 255 255 / 0.2); /* Muted-foreground/50 equivalent */
	}
	.worker-row.row-active-highlight-researching .worker-dot {
		@apply bg-status-blue shadow-status-blue;
	}
	.worker-row.row-active-highlight-building .worker-dot {
		@apply bg-brand shadow-brand;
	}
	.worker-row.row-active-highlight-verifying .worker-dot {
		@apply bg-status-purple shadow-status-purple;
	}
	.worker-row.row-active-highlight-blocked .worker-dot {
		@apply bg-status-red shadow-status-red;
	}
	.worker-row.complete .worker-dot {
		@apply bg-status-green;
	}

	.worker-identity {
		@apply font-semibold text-white;
	}

	.worker-role {
		@apply text-muted-foreground font-normal text-xs;
	}

	.worker-status {
		@apply text-muted-foreground text-xs;
	}

	.worker-badge-pill {
		@apply text-[9px] px-1.5 py-0.5 rounded-sm font-bold uppercase;
	}
</style>
