<script lang="ts">
	import type { TaskWorker } from '$lib/types/workSurface';
	import { workerBrandColor, workerBreathFinishing } from '$lib/utils/workerVisual';
	import { compactLiveStep } from '$lib/utils/glanceText';

	let { worker }: { worker: TaskWorker } = $props();

	// TODO Phase 2: bind amplitude to event count

	const wState = $derived(worker.status || 'idle');
	const isBreathFinishing = $derived(workerBreathFinishing(worker));

	const workerBrandColorValue = $derived(workerBrandColor(worker.identity, worker.shortCode));

	const strokeColor = $derived.by(() => {
		if (wState === 'active') return workerBrandColorValue;
		if (wState === 'idle' || wState === 'queued') return 'var(--color-st-done)';
		if (wState === 'done') return 'var(--color-status-green)';
		if (wState === 'failed') return 'var(--color-st-fail)';
		return 'var(--color-st-done)';
	});

	const rawActionText = $derived(worker.step || worker.status || 'idle');
	const actionText = $derived(compactLiveStep(rawActionText, 24));
</script>

<div
	class="worker-row-shell flex items-center gap-3 py-2"
	class:worker-row-active={wState === 'active'}
	style:--worker-color={workerBrandColorValue}
>
	<span class="ws-code w-10 flex-none text-[11px] text-foreground">{worker.shortCode}</span>

	<svg
		width="60"
		height="16"
		viewBox="0 0 60 16"
		class="max-w-32 flex-none select-none {wState === 'done' ? 'wave-done' : ''}"
		style="color: {strokeColor}; opacity: {wState === 'idle' ? 0.5 : 1};"
		role="img"
		aria-label={`${worker.shortCode} ${wState}`}
	>
		{#if wState === 'active'}
			<rect
				x="10"
				y="12"
				width="4"
				height="4"
				rx="2"
				class="bar-active bar-active-1 worker-surface-wave-breath {isBreathFinishing
					? 'worker-surface-breath--finishing'
					: ''}"
			/>
			<rect
				x="20"
				y="12"
				width="4"
				height="4"
				rx="2"
				class="bar-active bar-active-2 worker-surface-wave-breath {isBreathFinishing
					? 'worker-surface-breath--finishing'
					: ''}"
			/>
			<rect
				x="30"
				y="12"
				width="4"
				height="4"
				rx="2"
				class="bar-active bar-active-3 worker-surface-wave-breath {isBreathFinishing
					? 'worker-surface-breath--finishing'
					: ''}"
			/>
			<rect
				x="40"
				y="12"
				width="4"
				height="4"
				rx="2"
				class="bar-active bar-active-4 worker-surface-wave-breath {isBreathFinishing
					? 'worker-surface-breath--finishing'
					: ''}"
			/>
			<rect
				x="50"
				y="12"
				width="4"
				height="4"
				rx="2"
				class="bar-active bar-active-5 worker-surface-wave-breath {isBreathFinishing
					? 'worker-surface-breath--finishing'
					: ''}"
			/>
		{:else if wState === 'idle' || wState === 'queued'}
			<rect x="10" y="13" width="4" height="3" rx="1.5" />
			<rect x="20" y="13" width="4" height="3" rx="1.5" />
			<rect x="30" y="13" width="4" height="3" rx="1.5" />
			<rect x="40" y="13" width="4" height="3" rx="1.5" />
			<rect x="50" y="13" width="4" height="3" rx="1.5" />
		{:else if wState === 'done'}
			<rect x="10" y="12" width="4" height="4" rx="2" />
			<rect x="20" y="12" width="4" height="4" rx="2" />
			<rect x="30" y="12" width="4" height="4" rx="2" />
			<rect x="40" y="12" width="4" height="4" rx="2" />
			<rect x="50" y="12" width="4" height="4" rx="2" />
		{:else}
			<rect x="10" y="12" width="4" height="4" rx="2" />
			<rect x="20" y="12" width="4" height="4" rx="2" />
			<rect x="30" y="12" width="4" height="4" rx="2" />
			<rect x="40" y="12" width="4" height="4" rx="2" />
			<rect x="50" y="12" width="4" height="4" rx="2" />
		{/if}
	</svg>

	<span class="ws-live min-w-0 flex-1 truncate text-[12px]" title={rawActionText}>{actionText}</span
	>
</div>

<style>
	.worker-row-shell.worker-row-active {
		border-radius: var(--r-md);
		border: 1px solid color-mix(in srgb, var(--worker-color) 24%, rgb(255 255 255 / 0.08));
		background: linear-gradient(
			180deg,
			color-mix(in srgb, var(--worker-color) 9%, rgb(255 255 255 / 0.04)) 0%,
			rgb(255 255 255 / 0.02) 100%
		);
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.05);
		padding-left: 0.625rem;
		padding-right: 0.375rem;
	}

	rect {
		fill: currentColor;
		transition:
			height 0.2s ease,
			y 0.2s ease;
	}

	.bar-active {
		filter: drop-shadow(0 0 3px currentColor);
	}

	.bar-active-1 {
		animation-delay: 0s;
	}
	.bar-active-2 {
		animation-delay: 0.1s;
	}
	.bar-active-3 {
		animation-delay: 0.2s;
	}
	.bar-active-4 {
		animation-delay: 0.3s;
	}
	.bar-active-5 {
		animation-delay: 0.4s;
	}

	.wave-done {
		animation: pulse-once-fade 0.6s ease-out forwards;
	}

	@keyframes pulse-once-fade {
		0% {
			opacity: 1;
		}
		100% {
			opacity: 0.3;
		}
	}
</style>
