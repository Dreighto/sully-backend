<script lang="ts">
	// WorkSurfaceIndicator — the small pill that lives next to the chat composer.
	// The ONE entry point to the work surface (the dock no longer auto-appears).
	//
	// Reads the surfaces store; renders one of four visual states:
	//   - idle           → quiet, 0.5 opacity neutral dot, no animation
	//   - working        → muted-rose dot pulses + "▶ N"
	//   - needs-you      → amber border + faster-pulse amber dot + "⏸ N needs you"
	//                      (the ONLY state that reaches for attention)
	//   - recent-complete → a green dot fades over 6s alongside whatever state we're in
	//
	// Tap → opens the sheet directly on the most-important surface (needs-you
	// priority, then running, then done). One tap to the thing that matters.
	import { running, needsYou, done } from '$lib/data/surfaces.svelte';

	type Mode = 'badge' | 'rail' | 'sheet';
	let {
		mode = $bindable<Mode>('badge'),
		openSurfaceId = $bindable<string | null>(null)
	}: {
		mode?: Mode;
		openSurfaceId?: string | null;
	} = $props();

	// surfaces.svelte exports getter FUNCTIONS (Svelte 5 forbids exporting
	// $derived from a module); wrap them so this component is reactive.
	const runningList = $derived(running());
	const needsYouList = $derived(needsYou());
	const doneList = $derived(done());

	// Detect a fresh completion (done-count just went up) → flash a green dot
	// for 6s, then it fades. Tracks the previous count and a timestamp.
	let lastDoneCount = 0;
	let recentCompleteUntil = $state(0); // ms timestamp; 0 = no recent completion
	let tick = $state(0); // bump to force isRecentComplete to re-derive

	$effect(() => {
		const n = doneList.length;
		if (n > lastDoneCount) {
			// schedule the recent-complete dot to fade out 6000ms from now
			const until = Date.now() + 6000;
			recentCompleteUntil = until;
			const timer = setTimeout(() => {
				tick++; // force re-eval; the $derived below clears
			}, 6050);
			lastDoneCount = n;
			return () => clearTimeout(timer);
		}
		lastDoneCount = n;
	});

	const isRecentComplete = $derived(
		// touch `tick` so the timeout above flushes us
		tick >= 0 && recentCompleteUntil > Date.now()
	);

	// Visual state classification (drives label + which dots show)
	const hasNeedsYou = $derived(needsYouList.length > 0);
	const hasRunning = $derived(runningList.length > 0);
	const isIdle = $derived(!hasRunning && !hasNeedsYou);

	const activeWorkerCount = $derived.by(() => {
		let count = 0;
		for (const s of runningList) {
			for (const w of s.task.workers) {
				if (w.status === 'active') count++;
			}
		}
		for (const s of needsYouList) {
			for (const w of s.task.workers) {
				if (w.status === 'active') count++;
			}
		}
		return count;
	});

	const pulseDuration = $derived.by(() => {
		if (activeWorkerCount >= 3) return 0.6;
		if (activeWorkerCount >= 1) return 1.6;
		return 2.0;
	});

	function openMostImportant() {
		// Needs-you wins, then running, then done. Stable: same input = same result.
		const target =
			needsYouList[0]?.surfaceId ?? runningList[0]?.surfaceId ?? doneList[0]?.surfaceId ?? null;
		if (target === null) return; // nothing to open
		openSurfaceId = target;
		mode = 'sheet';
	}

	const ariaLabel = $derived(
		hasNeedsYou
			? `${needsYouList.length} surface${needsYouList.length === 1 ? '' : 's'} need attention — open Work Surface`
			: hasRunning
				? `${runningList.length} surface${runningList.length === 1 ? '' : 's'} running — open Work Surface`
				: 'Open Work Surface'
	);
</script>

{#if !isIdle || isRecentComplete}
	<!-- Pill: state-driven dots + label. Border amber only if needs-you. -->
	<button
		type="button"
		class="inline-flex h-11 items-center gap-2 rounded-full border bg-card px-3 text-xs font-medium text-foreground transition-colors {hasNeedsYou
			? 'border-st-needs'
			: 'border-border'}"
		onclick={openMostImportant}
		aria-label={ariaLabel}
	>
		{#if hasRunning}
			<span
				class="dot-pulse-soft h-2 w-2 rounded-full bg-st-run"
				style="animation-duration: {pulseDuration}s"
				aria-hidden="true"
			></span>
			<span>▶ {runningList.length}</span>
		{/if}

		{#if hasNeedsYou}
			<span
				class="dot-pulse-urgent h-2 w-2 rounded-full bg-st-needs"
				style="animation-duration: {pulseDuration}s"
				aria-hidden="true"
			></span>
			<span>⏸ {needsYouList.length} needs you</span>
		{/if}

		{#if isRecentComplete}
			<span class="dot-pulse-once h-2 w-2 rounded-full bg-status-green" aria-hidden="true"
			></span>
		{/if}
	</button>
{/if}

<style>
	/* Soft pulse for the running state — calm, sustained. */
	.dot-pulse-soft {
		animation: pulse-soft 1.6s ease-in-out infinite;
	}
	/* Faster pulse for needs-you — more urgent. */
	.dot-pulse-urgent {
		animation: pulse-soft 1s ease-in-out infinite;
	}
	/* One-shot fade for the recent-complete dot — sustained 5s then fades. */
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
