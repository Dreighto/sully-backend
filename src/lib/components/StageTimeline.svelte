<script lang="ts">
	import type { WorkSurfaceTask } from '$lib/types/workSurface';

	let { task }: { task: WorkSurfaceTask } = $props();

	const allowedStages = ['READ', 'RESEARCH', 'BUILD', 'CHECK', 'APPROVE'];

	const filteredProgress = $derived.by(() => {
		return task.stageProgress.filter((step) => allowedStages.includes(step.stage.toUpperCase()));
	});
</script>

<div class="stage-timeline">
	{#each filteredProgress as step, index (step.stage)}
		<div class="segment" class:active={step.status === 'active'} class:done={step.status === 'done'}>
			<div class="station">
				<div class="dot">
					{#if step.status === 'done'}
						<svg class="tick" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="2.5,5 4.5,7 7.5,3"></polyline>
						</svg>
					{/if}
				</div>
				<div class="label">{step.stage}</div>
			</div>
			{#if index < filteredProgress.length - 1}
				<div class="connector"></div>
			{/if}
		</div>
	{/each}
</div>

<style lang="postcss">
	.stage-timeline {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 1rem;
		width: 100%;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.stage-timeline::-webkit-scrollbar {
		display: none;
	}

	.segment {
		display: flex;
		align-items: flex-start;
		flex: 1;
	}
	.segment:last-child {
		flex: 0;
	}

	.station {
		display: flex;
		flex-direction: column;
		align-items: center;
		position: relative;
		z-index: 2;
	}

	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 1px solid var(--color-border);
		background-color: transparent;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 4px;
		transition: all 0.2s ease;
	}
	
	.segment.done .dot {
		background-color: color-mix(in srgb, var(--color-st-done) 70%, transparent);
		border-color: transparent;
	}

	.segment.done .tick {
		width: 6px;
		height: 6px;
		color: var(--color-background, #111);
	}

	.segment.active .dot {
		width: 12px;
		height: 12px;
		background-color: var(--color-st-run);
		border-color: var(--color-st-run);
		margin-bottom: 3px; /* compensate for larger size */
	}
	
	/* Future stations: 30% opacity done color */
	.segment:not(.active):not(.done) .dot {
		border-color: color-mix(in srgb, var(--color-st-done) 30%, transparent);
	}

	.label {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-muted-foreground);
		white-space: nowrap;
	}
	.segment.active .label {
		color: var(--color-foreground, #fff);
	}

	.connector {
		flex: 1;
		height: 1px;
		background-color: var(--color-border);
		margin-top: 5px; /* align with dots */
		margin-left: 4px;
		margin-right: 4px;
		opacity: 0.5;
	}
	.segment.done .connector {
		background-color: var(--color-st-done);
		opacity: 0.5;
	}
</style>
