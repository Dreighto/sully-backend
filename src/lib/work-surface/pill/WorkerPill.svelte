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
		parsePillTs,
		derivePillTrust,
		pillAnimFor,
		BRAND_REVEALS
	} from './pillModel';
	import WorkerStateAnim from './WorkerStateAnim.svelte';

	let {
		traceId,
		rows,
		status,
		worker,
		brief,
		startedAtIso,
		durationLabel,
		reconciled = true,
		onstalereconcile = null
	}: {
		traceId: string;
		rows: StreamRow[];
		status: string;
		worker: string | null;
		brief: string | null;
		startedAtIso: string | null;
		durationLabel: string | null;
		/** Truth guard (LOS-196): false until the stream's first successful
		 *  reconcile — a non-terminal status is rendered as "checking…" until
		 *  server truth has confirmed it once. Defaults true so fixture-driven
		 *  render call sites keep their existing behavior. */
		reconciled?: boolean;
		/** Fired when the stale guard wants a forced server-truth reconcile. */
		onstalereconcile?: (() => void) | null;
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

	// Truth guard (LOS-196): trust derives from terminal/reconciled/elapsed.
	// 'unverified' = no successful reconcile yet; 'stale' = non-terminal past
	// the max-elapsed cap. Both render an explicit checking label instead of a
	// confidently-live clock.
	const trust = $derived(derivePillTrust({ terminal, reconciled, startedAtIso, nowMs }));
	const checkLabel = $derived(
		trust === 'stale' ? 'stale — checking…' : trust === 'unverified' ? 'checking…' : null
	);

	// Stale guard forces a server-truth reconcile: once on entering the stale
	// state, then every 60s while it persists (covers an offline/failed fetch).
	// `trust` is a memoized $derived, so the effect re-runs only on a real
	// state change, not on every ticker advance.
	$effect(() => {
		if (trust !== 'stale') return;
		onstalereconcile?.();
		const t = setInterval(() => onstalereconcile?.(), 60_000);
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
		`${who.display} · ${title} · ${STATE_LABELS[aggr] ?? aggr}${checkLabel ? ` · ${checkLabel}` : elapsedLabel ? ` · ${elapsedLabel}` : ''}`
	);

	// Working-state animation (operator-approved Lottie set). Primitives only:
	// `anim` is a fresh object whenever `stages` recomputes (every stream row),
	// so the component consumes file/loop strings to avoid player churn.
	const anim = $derived(pillAnimFor({ status, aggr, stages, trust }));

	// Approved brand reveal as the mount intro: plays once when a LIVE, TRUSTED
	// run appears (dispatch confirmation), then the state animation takes over.
	// Terminal or unverified pills skip it — same truth guards as pillAnimFor.
	let introActive = $state(false);
	$effect(() => {
		if (terminal || trust !== 'trusted') {
			introActive = false;
			return;
		}
		introActive = true;
		const t = setTimeout(() => (introActive = false), 2900);
		return () => clearTimeout(t);
	});
	const introFile = $derived(introActive ? (BRAND_REVEALS[who.shortCode] ?? null) : null);
	const animFile = $derived(introFile ?? anim?.file ?? null);
	const animLoop = $derived(introFile ? false : (anim?.loop ?? true));
</script>

<div
	class="wpill wpill--{aggr}"
	class:wpill--checking={checkLabel !== null}
	data-testid="worker-pill"
	data-aggr={aggr}
	data-trust={trust}
	data-trace-id={traceId}
	role="status"
	aria-label={a11yLabel}
>
	<WorkerStateAnim file={animFile} loop={animLoop} size={18} />
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
	{#if checkLabel}
		<!-- Truth guard: the live clock is replaced by an explicit checking
		     label whenever the status is unverified or past the stale cap. -->
		<span class="wpill-stale" data-testid="worker-pill-stale" data-trust={trust}>
			{checkLabel}
		</span>
	{:else if elapsedLabel}
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

	/* Truth guard (LOS-196): an unverified/stale pill must not wear the live
	   tint or pulse — neutral surface until server truth confirms the run.
	   Locked tokens only (the same neutral pair as the base pill). */
	.wpill--checking {
		background: var(--surface-card);
		border-color: var(--line2);
	}
	.wpill--checking .wpill-dot--active {
		animation: none;
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

	/* The checking label sits where the clock would — same quiet mono voice. */
	.wpill-stale {
		flex: none;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--t3);
		white-space: nowrap;
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
