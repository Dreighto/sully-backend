<!--
  WorkerPill.svelte — the landed collapsed worker pill (LOS-192, part 1).

  In-feed representation of a dispatched background run:
      [worker chip] [task] [stage dots ······] [elapsed]
  driven entirely by the EXISTING dispatch stream (createDispatchStream
  getters passed as props — same pipeline the legacy card consumed). No new
  verification plumbing; the pill renders what the stream provides.

  Truth guards (operator-locked, standing):
    - no fake done while running — terminal glyphs/dimming key off the stream
      status alone, never off row contents or wall-clock
    - worker lanes persist — a finished run dims (opacity), it never unmounts
    - skipped ≠ done visually — skipped dots are hollow rings, done dots are
      filled; a bypassed stage can never read as a completed one
    - result-files row only when files exist — the collapsed pill renders no
      files row at all (that surface arrives with the part-2 sheet)

  Tap is a deliberate no-op placeholder — the run sheet lands in part 2
  (separate ticket). Locked tokens only (sully-locked-spec §5): --live for
  live states, --*-bg/--*-line pairs for status tinting, --r-pill, mono
  tabular for elapsed. Zero orange, zero raw hexes. Animation is
  opacity-only; prefers-reduced-motion neutralizes it.
-->
<script lang="ts">
	import type { StreamRow } from '$lib/chat/dispatchReconcile';
	import {
		mapStreamStatusToAggr,
		isTerminalAggr,
		deriveStageDots,
		pillWorker,
		fmtElapsed,
		parsePillTs
	} from './pillModel';

	let {
		traceId,
		rows,
		status,
		worker,
		brief,
		startedAtIso,
		durationLabel
	}: {
		traceId: string;
		rows: StreamRow[];
		status: string;
		worker: string | null;
		brief: string | null;
		startedAtIso: string | null;
		durationLabel: string | null;
	} = $props();

	const aggr = $derived(mapStreamStatusToAggr(status));
	const terminal = $derived(isTerminalAggr(aggr));
	const stages = $derived(deriveStageDots(rows, aggr));
	const who = $derived(pillWorker(worker, traceId));
	const title = $derived((brief || '').trim() || 'Working on it');

	// Live elapsed ticker. nowMs only advances while the run is in flight; at
	// terminal the frozen server-truth durationLabel takes over, so the timer
	// can never count past the real end (truth guard: no live digits lying
	// about a finished run). Synchronous reads of `terminal`/`startedAtIso`
	// keep them tracked as deps; the interval is cleaned up on every re-run
	// and on destroy.
	let nowMs = $state(Date.now());
	$effect(() => {
		const isTerminal = terminal;
		const hasStart = startedAtIso !== null;
		if (isTerminal || !hasStart) return;
		const t = setInterval(() => {
			nowMs = Date.now();
		}, 1000);
		return () => clearInterval(t);
	});

	const elapsedLabel = $derived.by(() => {
		if (terminal) {
			if (durationLabel) return durationLabel;
			const start = parsePillTs(startedAtIso);
			return Number.isFinite(start) ? fmtElapsed(Date.now() - start) : '';
		}
		const start = parsePillTs(startedAtIso);
		if (!Number.isFinite(start)) return '';
		return fmtElapsed(nowMs - start);
	});

	const STATE_LABELS: Record<string, string> = {
		running: 'running',
		'needs-you': 'needs you',
		blocked: 'blocked',
		done: 'done',
		failed: 'failed',
		stopped: 'stopped'
	};
	const a11yLabel = $derived(
		`${who.display} · ${title} · ${STATE_LABELS[aggr] ?? aggr}${elapsedLabel ? ` · ${elapsedLabel}` : ''}`
	);
</script>

<div
	class="wpill wpill--{aggr}"
	data-testid="worker-pill"
	data-aggr={aggr}
	data-trace-id={traceId}
	role="status"
	aria-label={a11yLabel}
>
	<span class="wpill-worker" data-testid="worker-pill-worker" title={who.display}>
		{who.shortCode}
	</span>
	<span class="wpill-task" data-testid="worker-pill-task">{title}</span>
	<span class="wpill-stages" data-testid="worker-pill-stages" aria-hidden="true">
		{#each stages as s (s.key)}
			<span
				class="wpill-dot wpill-dot--{s.status}"
				data-testid="worker-pill-stage-dot"
				data-stage={s.key}
				data-status={s.status}
			></span>
		{/each}
	</span>
	{#if elapsedLabel}
		<span class="wpill-elapsed" data-testid="worker-pill-elapsed">{elapsedLabel}</span>
	{/if}
</div>

<style>
	.wpill {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		max-width: 100%;
		min-width: 0;
		min-height: 44px;
		box-sizing: border-box;
		padding: 8px 14px;
		border-radius: var(--r-pill);
		background: var(--surface-card);
		border: 1px solid var(--line2);
		animation: wpill-enter var(--dur-base) var(--ease-enter) both;
	}

	/* Status tinting — exclusively via the locked --*-bg / --*-line pairs. */
	.wpill--running {
		background: var(--live-bg);
		border-color: var(--live-line);
	}
	.wpill--needs-you,
	.wpill--blocked {
		background: var(--amber-bg);
		border-color: var(--amber-line);
	}
	.wpill--failed {
		background: var(--red-bg);
		border-color: var(--red-line);
	}
	/* Terminal lanes persist: done/stopped dim, they never disappear. */
	.wpill--done {
		opacity: 0.72;
	}
	.wpill--stopped {
		opacity: 0.6;
	}

	.wpill-worker {
		flex: none;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		letter-spacing: 0.04em;
		color: var(--t2);
		background: var(--worker-bg);
		border: 1px solid var(--worker-border);
		border-radius: var(--r-pill);
		padding: 2px 8px;
	}

	.wpill-task {
		flex: 1 1 0;
		min-width: 0;
		font-size: var(--text-sm);
		line-height: var(--leading-sm);
		font-weight: var(--weight-medium);
		color: var(--t1);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.wpill-stages {
		flex: none;
		display: flex;
		align-items: center;
		gap: 5px;
	}

	.wpill-dot {
		width: 6px;
		height: 6px;
		border-radius: var(--r-pill);
		box-sizing: border-box;
	}
	.wpill-dot--done {
		background: var(--ui);
	}
	/* Live accent — the worker-pill active dot is the spec's canonical --live
	   use. Opacity-only breath. */
	.wpill-dot--active {
		background: var(--live);
		animation: wpill-breath var(--dur-ambient) var(--ease-standard) infinite;
	}
	.wpill-dot--pending {
		background: var(--line3);
	}
	/* Skipped ≠ done: hollow ring vs filled dot. */
	.wpill-dot--skipped {
		background: transparent;
		border: 1px solid var(--line3);
	}
	.wpill-dot--failed {
		background: var(--red);
	}
	.wpill-dot--needs-you {
		background: var(--amber);
		animation: wpill-breath var(--dur-ambient-fast) var(--ease-standard) infinite;
	}
	.wpill-dot--blocked {
		background: var(--amber);
	}

	.wpill-elapsed {
		flex: none;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		color: var(--t3);
	}

	/* transform/opacity only — no layout or paint properties animate. */
	@keyframes wpill-enter {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@keyframes wpill-breath {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.wpill {
			animation: none;
		}
		.wpill-dot--active,
		.wpill-dot--needs-you {
			animation: none;
		}
	}
</style>
