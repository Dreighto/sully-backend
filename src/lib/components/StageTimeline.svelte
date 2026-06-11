<script lang="ts">
	import type { WorkSurfaceTask, PipelineStage } from '$lib/types/workSurface';
	import {
		BookOpen,
		Search,
		Hammer,
		ClipboardCheck,
		ShieldCheck,
		MessageCircle,
		type Icon
	} from 'lucide-svelte';

	let { task, showDurations = false }: { task: WorkSurfaceTask; showDurations?: boolean } =
		$props();

	const STAGE_ICONS: Record<PipelineStage, typeof Icon> = {
		Read: BookOpen,
		Research: Search,
		Build: Hammer,
		Check: ClipboardCheck,
		Approve: ShieldCheck,
		Reply: MessageCircle
	};

	function formatDuration(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		return `${hours}h ${remainingMinutes}m`;
	}

	const steps = $derived(task.stageProgress);
</script>

<div class="stage-timeline">
	{#each steps as step, index (step.stage)}
		{@const IconCmp = STAGE_ICONS[step.stage]}
		{@const isReply = step.stage === 'Reply'}
		<div
			class="segment"
			class:active={step.status === 'active'}
			class:done={step.status === 'done'}
			class:skipped={step.status === 'skipped'}
			class:reply={isReply}
		>
			<div class="station">
				<div class="icon-slot" class:reply-slot={isReply}>
					{#if step.status === 'done'}
						<svg
							class="tick"
							viewBox="0 0 10 10"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<polyline points="2.5,5 4.5,7 7.5,3"></polyline>
						</svg>
					{:else if IconCmp}
						<IconCmp size={isReply ? 11 : 10} strokeWidth={2} aria-hidden="true" />
					{/if}
				</div>
				<div class="label">{step.stage}</div>
				{#if showDurations && step.durationMs !== undefined}
					<div class="duration">{formatDuration(step.durationMs)}</div>
				{/if}
			</div>
			{#if index < steps.length - 1}
				{@const nextStep = steps[index + 1]}
				{@const leadsToReply = nextStep?.stage === 'Reply'}
				<div
					class="connector"
					class:active-connector={step.status === 'done' || step.status === 'active'}
					class:marching={step.status === 'active' && task.state === 'Working'}
					class:reply-approach={leadsToReply}
				>
					<svg width="100%" height="2" preserveAspectRatio="none" aria-hidden="true">
						<line x1="0" y1="1" x2="100%" y2="1" class="connector-line" />
					</svg>
				</div>
			{/if}
		</div>
	{/each}
</div>

<style lang="postcss">
	.stage-timeline {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 0.5rem;
		width: 100%;
		overflow-x: auto;
		scrollbar-width: none;
		padding-bottom: 2px;
	}
	.stage-timeline::-webkit-scrollbar {
		display: none;
	}

	.segment {
		display: flex;
		align-items: flex-start;
		flex: 1;
		min-width: 0;
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
		transition: opacity var(--dur-slow) ease;
		min-width: 2.75rem;
	}

	.segment.done .station {
		opacity: 0.85;
	}

	.segment:not(.active):not(.done):not(.skipped) .station {
		opacity: 0.35;
	}

	.segment.skipped .station {
		opacity: 0.25;
	}

	.icon-slot {
		width: 22px;
		height: 22px;
		border-radius: var(--r-pill);
		border: 1px solid var(--line2);
		background-color: var(--line);
		box-shadow: inset 0 1px 0 var(--line);
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 4px;
		color: var(--color-muted-foreground);
		transition:
			border-color 0.2s ease,
			background-color 0.2s ease,
			color 0.2s ease,
			box-shadow 0.2s ease;
	}

	.icon-slot.reply-slot {
		border-radius: var(--r-sm);
	}

	.segment.done .icon-slot {
		background-color: color-mix(in srgb, var(--color-st-done) 75%, transparent);
		border-color: color-mix(in srgb, var(--color-st-done) 40%, transparent);
		color: var(--color-background, #0a0a0a);
	}

	.segment.done .tick {
		width: 8px;
		height: 8px;
	}

	.segment.active .icon-slot {
		border-color: var(--live-line);
		background-color: var(--live-bg);
		color: var(--color-st-run);
		box-shadow:
			inset 0 1px 0 var(--line2),
			0 0 12px var(--accent-glow);
		animation: pulse-soft var(--dur-ambient) ease-in-out infinite alternate;
	}

	.segment.active.reply .icon-slot {
		border-color: var(--color-status-green);
		background-color: color-mix(in srgb, var(--color-status-green) 16%, #111);
		color: var(--color-status-green);
		box-shadow: 0 0 12px color-mix(in srgb, var(--color-status-green) 40%, transparent);
	}

	.label {
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0.02em;
		color: color-mix(in srgb, var(--color-foreground) 55%, transparent);
		white-space: nowrap;
		text-align: center;
		max-width: 4.5rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.segment.active .label {
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--t1);
	}
	.segment.reply.active .label,
	.segment.reply.done .label {
		color: color-mix(in srgb, var(--color-status-green) 85%, white);
	}

	.duration {
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 9px;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.02em;
		color: color-mix(in srgb, var(--color-foreground) 48%, transparent);
	}

	.connector {
		flex: 1;
		margin-top: 11px;
		margin-left: 2px;
		margin-right: 2px;
		display: flex;
		align-items: center;
		min-width: 0.5rem;
	}
	.connector svg {
		width: 100%;
		height: 2px;
		display: block;
		overflow: visible;
	}
	.connector-line {
		stroke: var(--color-border);
		stroke-width: 1px;
		opacity: 0.35;
		transition: all var(--dur-base) ease;
	}

	.segment.done .connector-line,
	.connector.active-connector .connector-line {
		stroke: var(--color-st-run);
		opacity: 1;
		stroke-width: 1.5px;
	}

	.connector.marching .connector-line {
		stroke: var(--color-st-run);
		opacity: 0.85;
		stroke-width: 1.5px;
		stroke-dasharray: 3 3;
		animation: connectorMarch 2.5s linear infinite;
	}

	.connector.reply-approach .connector-line {
		stroke: color-mix(in srgb, var(--color-st-run) 55%, var(--color-status-green));
		opacity: 0.95;
		stroke-width: 2px;
		filter: drop-shadow(0 0 3px color-mix(in srgb, var(--color-status-green) 35%, transparent));
	}

	.connector.reply-approach.marching .connector-line {
		stroke-dasharray: 4 2;
		animation: connectorMarchReply 1.8s linear infinite;
	}

	@keyframes pulse-soft {
		from {
			opacity: 1;
		}
		to {
			opacity: 0.72;
		}
	}

	@keyframes connectorMarch {
		to {
			stroke-dashoffset: -6;
		}
	}

	@keyframes connectorMarchReply {
		to {
			stroke-dashoffset: -8;
		}
	}
</style>
