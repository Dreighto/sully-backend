<script lang="ts">
	import type { TaskWorker } from '$lib/types/workSurface';

	let { worker }: { worker: TaskWorker } = $props();

	// TODO Phase 2: bind amplitude to event count

	// Per the WorkerStatus contract: queued | active | done | failed | idle.
	// (Cursor audit 2026-06-06 finding: previous 'string' widening let an
	// unreachable 'waiting' branch slip through. Workers don't wait — the
	// SURFACE does.)
	const wState = $derived(worker.status || 'idle');

	// Per-identity brand colour (operator-locked 2026-06-06):
	//   CC (claude-code)   → orange  — Anthropic / Claude orange
	//   AGY (antigravity)  → purple  — Google AI / Antigravity purple
	//   CDX (codex)        → gray    — OpenAI Codex neutral
	//   DPSK (deepseek)    → blue    — DeepSeek brand blue
	//   GMI (gemini)       → light   — Gemini lighter blue
	// Colour reflects the WORKER, not the role — each worker is a brand.
	const workerBrandColor = $derived.by((): string => {
		const id = (worker.identity || '').toLowerCase();
		const code = (worker.shortCode || '').toUpperCase();
		if (id === 'claude-code' || code === 'CC') return '#f97316'; // orange
		if (id === 'antigravity' || code === 'AGY') return '#a855f7'; // purple
		if (id === 'codex' || code === 'CDX') return '#9ca3af'; // gray
		if (id === 'deepseek' || code === 'DPSK') return '#3b82f6'; // blue
		if (id === 'gemini' || code === 'GMI') return '#60a5fa'; // light blue
		// Unknown identity — fall back to status-blue for active workers
		return 'var(--color-status-blue)';
	});

	const strokeColor = $derived.by(() => {
		if (wState === 'active') return workerBrandColor;
		if (wState === 'idle' || wState === 'queued') return 'var(--color-st-done)'; // gray
		if (wState === 'done') return 'var(--color-status-green)'; // green
		if (wState === 'failed') return 'var(--color-st-fail)'; // muted rose
		return 'var(--color-st-done)';
	});

	const actionText = $derived(worker.step || worker.status || 'idle');
</script>

<div class="flex items-center gap-3 py-2">
	<span class="w-10 flex-none font-mono text-[12px] text-foreground">{worker.shortCode}</span>

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
			<rect x="10" y="12" width="4" height="4" rx="2" class="bar-active bar-active-1" />
			<rect x="20" y="12" width="4" height="4" rx="2" class="bar-active bar-active-2" />
			<rect x="30" y="12" width="4" height="4" rx="2" class="bar-active bar-active-3" />
			<rect x="40" y="12" width="4" height="4" rx="2" class="bar-active bar-active-4" />
			<rect x="50" y="12" width="4" height="4" rx="2" class="bar-active bar-active-5" />
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

	<span class="flex-1 truncate text-sm text-muted-foreground">{actionText}</span>
</div>

<style>
	rect {
		fill: currentColor;
		transition:
			height 0.2s ease,
			y 0.2s ease;
	}

	@keyframes wave-active {
		0%,
		100% {
			height: 4px;
			y: 12px;
		}
		50% {
			height: 14px;
			y: 2px;
		}
	}

	.bar-active {
		animation: wave-active 1.2s ease-in-out infinite;
		/* Per-role glow — the waveform colour IS the worker's brand. The eye
		   should trace from this row to the same-coloured node in the graph
		   and read them as ONE worker. filter: drop-shadow uses currentColor
		   automatically via the rect's fill (set above), so this glow takes
		   the role colour with no extra wiring. */
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
