<script lang="ts">
	let {
		runningCount = 0,
		needsYouCount = 0,
		hasRunning = false,
		hasNeedsYou = false,
		isRecentComplete = false,
		pulseDuration = 1.6,
		ariaLabel = 'Open Work Surface',
		onclick
	}: {
		runningCount?: number;
		needsYouCount?: number;
		hasRunning?: boolean;
		hasNeedsYou?: boolean;
		isRecentComplete?: boolean;
		pulseDuration?: number;
		ariaLabel?: string;
		onclick?: () => void;
	} = $props();
</script>

<button
	type="button"
	class="work-surface-pill inline-flex h-11 min-w-[44px] items-center gap-2 rounded-[var(--r-pill)] border bg-card px-3 text-xs font-medium text-foreground transition-colors active:scale-[0.98] {hasNeedsYou
		? 'border-st-needs'
		: 'border-border'}"
	{onclick}
	aria-label={ariaLabel}
>
	{#if hasRunning}
		<span
			class="dot-pulse-soft h-2 w-2 rounded-[var(--r-pill)] bg-st-run"
			style="animation-duration: {pulseDuration}s"
			aria-hidden="true"
		></span>
		<span>▶ {runningCount}</span>
	{/if}

	{#if hasNeedsYou}
		<span
			class="dot-pulse-urgent h-2 w-2 rounded-[var(--r-pill)] bg-st-needs"
			style="animation-duration: {pulseDuration}s"
			aria-hidden="true"
		></span>
		<span>⏸ {needsYouCount} needs you</span>
	{/if}

	{#if isRecentComplete}
		<span class="dot-pulse-once h-2 w-2 rounded-[var(--r-pill)] bg-status-green" aria-hidden="true"
		></span>
	{/if}
</button>

<style>
	.work-surface-pill {
		-webkit-tap-highlight-color: transparent;
		touch-action: manipulation;
	}

	.dot-pulse-soft {
		animation: pulse-soft var(--dur-ambient) ease-in-out infinite;
	}
	.dot-pulse-urgent {
		animation: pulse-soft var(--dur-ambient-fast) ease-in-out infinite;
	}
	.dot-pulse-once {
		animation: pulse-once 6s ease-out forwards;
	}
	@keyframes pulse-soft {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.55;
		}
	}
	@keyframes pulse-once {
		0% {
			opacity: 1;
			transform: scale(1);
		}
		70% {
			opacity: 0.9;
		}
		100% {
			opacity: 0;
			transform: scale(0.8);
		}
	}
</style>
