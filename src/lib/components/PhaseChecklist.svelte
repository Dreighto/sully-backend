<script lang="ts">
	import type { WorkSurfaceTask } from '$lib/types/workSurface';

	let { task }: { task: WorkSurfaceTask } = $props();

	function formatDuration(ms: number): string {
		if (ms === undefined || ms === null) return '';
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) {
			return `${seconds}s`;
		}
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		if (minutes < 60) {
			return `${minutes}m ${remainingSeconds}s`;
		}
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		return `${hours}h ${remainingMinutes}m`;
	}
</script>

<div class="phases-checklist">
	{#each task.stageProgress as step (step.stage)}
		<div
			class="phase-row"
			class:done={step.status === 'done'}
			class:active={step.status === 'active'}
			class:pending={step.status === 'pending'}
			class:skipped={step.status === 'skipped'}
		>
			<div class="phase-left">
				<span
					class="phase-dot"
					class:done={step.status === 'done'}
					class:active={step.status === 'active'}
					class:pending={step.status === 'pending'}
				></span>
				<span>{step.stage}</span>
			</div>
			{#if step.durationMs !== undefined}
				<span class="phase-time">{formatDuration(step.durationMs)}</span>
			{/if}
		</div>
	{/each}
</div>

<style lang="postcss">
	@reference "../../app.css";
	.phases-checklist {
		@apply flex flex-col gap-1.5;
	}

	.phase-row {
		@apply flex items-center justify-between rounded-[var(--r-xs)] border border-border bg-surface px-3 py-2 text-sm transition-colors;
	}
	.phase-row.skipped {
		@apply border-dashed border-border opacity-60; /* Apply dashed border and dimming */
	}

	.phase-left {
		@apply flex items-center gap-2 text-white;
	}

	.phase-dot {
		@apply inline-block h-1.5 w-1.5 flex-shrink-0 rounded-[var(--r-pill)];
	}
	.phase-row.done .phase-dot {
		@apply bg-status-green;
	}
	.phase-row.active .phase-dot {
		@apply bg-st-run;
		animation: dotBreath 1.5s infinite;
	}
	.phase-row.pending .phase-dot {
		@apply border border-muted-foreground bg-transparent;
	}

	.phase-time {
		@apply font-mono text-xs text-muted-foreground;
	}

	@keyframes dotBreath {
		0%,
		100% {
			opacity: 0.5;
			transform: scale(0.95);
		}
		50% {
			opacity: 1;
			transform: scale(1.05);
		}
	}
</style>
