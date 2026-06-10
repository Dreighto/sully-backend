<script lang="ts">
	let {
		percent = 0,
		stage = '',
		surfaceState = 'Working'
	}: {
		percent: number;
		stage: string;
		surfaceState: 'Working' | 'Waiting' | 'Complete' | 'Failed';
	} = $props();

	const r = 60;
	const cx = 70;
	const cy = 70;
	const circumference = $derived(2 * Math.PI * r);
	const strokeDasharray = $derived.by(() => {
		const p = Math.min(100, Math.max(0, percent)) / 100;
		const activeLength = p * circumference;
		const remainingLength = circumference - activeLength;
		return `${activeLength} ${remainingLength}`;
	});

	const strokeColor = $derived.by(() => {
		switch (surfaceState) {
			case 'Working':
				return 'var(--color-st-run)';
			case 'Waiting':
				return 'var(--color-st-needs)';
			case 'Complete':
				return 'var(--color-status-green)';
			case 'Failed':
				return 'var(--color-st-fail)';
			default:
				return 'var(--color-st-run)';
		}
	});

	// Completion celebration — fires ONCE on the Complete transition (a real
	// event), then hands off to the rest-breath. The rest-breath persists as
	// long as the surface IS Complete (real ongoing state, not decoration).
	//
	// prevState is a PLAIN let, NOT $state — writing to it must not re-trigger
	// the effect, otherwise the cleanup fires and cancels the setTimeout
	// before celebration ends. Transition detection is non-reactive by design.
	let prevState = surfaceState;
	let celebrationActive = $state(false);

	$effect(() => {
		if (surfaceState === 'Complete' && prevState !== 'Complete') {
			celebrationActive = true;
			const t1 = setTimeout(() => {
				celebrationActive = false;
			}, 1600);
			prevState = surfaceState;
			return () => clearTimeout(t1);
		}
		prevState = surfaceState;
	});

	// Earned-rest breath: state=Complete AND the celebration has finished.
	const inEarnedRest = $derived(surfaceState === 'Complete' && !celebrationActive);
</script>

<div class="relative mx-auto flex h-[140px] w-[140px] items-center justify-center">
	<svg
		width="140"
		height="140"
		viewBox="0 0 140 140"
		class="select-none"
		role="img"
		aria-label={`${Math.round(percent)}% complete${stage ? ' · ' + stage : ''}`}
	>
		<!-- Background ring -->
		<circle
			{cx}
			{cy}
			{r}
			fill="none"
			stroke="var(--color-edge, rgba(255, 255, 255, 0.15))"
			stroke-width="1"
		/>
		<!-- Foreground arc -->
		<circle
			{cx}
			{cy}
			{r}
			fill="none"
			stroke={strokeColor}
			stroke-width="4"
			stroke-linecap="round"
			transform="rotate(-90 70 70)"
			stroke-dasharray={strokeDasharray}
			class="ring-foreground-arc {inEarnedRest ? 'rest-breath' : ''}"
		/>
		<!-- One-shot celebration pulse-out — fires on Complete TRANSITION only. -->
		{#if celebrationActive}
			<circle
				{cx}
				{cy}
				{r}
				fill="none"
				stroke="var(--color-status-green)"
				stroke-width="2"
				class="celebrate-pulse"
			/>
			<circle
				{cx}
				{cy}
				{r}
				fill="none"
				stroke="var(--color-status-green)"
				stroke-width="1"
				class="celebrate-pulse celebrate-pulse-delayed"
			/>
		{/if}
	</svg>
	<!-- Center label -->
	<div class="absolute flex flex-col items-center justify-center text-center">
		<span class="text-2xl font-semibold tracking-tight text-white">{Math.round(percent)}%</span>
		{#if stage}
			<span class="mt-0.5 text-[10px] font-bold tracking-wide text-muted-foreground uppercase"
				>{stage}</span
			>
		{/if}
	</div>
</div>

<style>
	.ring-foreground-arc {
		transition: stroke-dasharray var(--dur-long) var(--ease-standard);
	}

	/* Earned-rest breath — fires AFTER the completion celebration. Slow, gentle,
	   8s ease-in-out. This is doctrine-bound to the Complete surfaceState, not
	   decoration: the surface IS at rest, and the breath is the visual proof of
	   "settled, alive, satisfied." Stops the instant surfaceState leaves Complete. */
	.ring-foreground-arc.rest-breath {
		animation: rest-breath 4s ease-in-out infinite;
	}
	@keyframes rest-breath {
		0%,
		100% {
			opacity: 1;
			stroke-width: 4;
		}
		50% {
			opacity: 0.7;
			stroke-width: 5;
		}
	}

	/* Celebration pulse — one-shot expanding ring on Complete transition.
	   Fires once, decays over 1.6s, then handed off to rest-breath. */
	.celebrate-pulse {
		transform-origin: 70px 70px;
		animation: celebrate-pulse 1.6s ease-out forwards;
		filter: drop-shadow(0 0 6px var(--color-status-green));
	}
	.celebrate-pulse-delayed {
		animation-delay: var(--dur-slow);
	}
	@keyframes celebrate-pulse {
		0% {
			transform: scale(1);
			opacity: 0.9;
		}
		100% {
			transform: scale(1.45);
			opacity: 0;
		}
	}
</style>
