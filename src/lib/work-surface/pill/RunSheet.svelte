<!--
  RunSheet.svelte — the run sheet behind the WorkerPill tap (LOS-193, part 2).

  Mobile-first bottom sheet: step timeline · gate badges · collapsed log row ·
  result files — ALL derived from the EXISTING dispatch stream props the pill
  already consumes (rows/status/job fields). No new verification plumbing:
  every section renders only what the stream provides, and an empty selector
  renders nothing (truth guard: absent data = absent row — the files row only
  exists when the worker actually wrote files; gate badges only when a gate
  actually ran).

  Truth guards (operator-locked, standing):
    - no fake done while running — the state label keys off the stream status
      alone; the timeline frontier maps the aggregate honestly
    - lanes persist — a terminal sheet renders dimmed/quiet, never empty
    - skipped ≠ done visually — hollow ring + "skipped" text vs filled dot
    - trust (LOS-196) carries over: unverified/stale runs show "checking…",
      never a confidently-live clock

  Motion (locked set): enter/exit on --ease-sheet with --dur-long (enter) /
  --dur-panel (exit), transform/opacity ONLY; prefers-reduced-motion drops the
  choreography entirely. Swipe-down dismiss via the shared createSheetDrag
  factory (vaul-faithful, iOS-proven): the exit keyframes declare only a `to`
  frame, so a factory-driven drag dismissal (inline translateY(100%)) hands
  off to the scrim fade without the sheet jumping back up. Scrim tap, the X
  button, and Escape all dismiss. Locked tokens only — zero raw hexes.
-->
<script lang="ts">
	import { X, ChevronDown } from 'lucide-svelte';
	import type { StreamRow } from '$lib/chat/dispatchReconcile';
	import { createSheetDrag } from '$lib/utils/sheetDrag.svelte';
	import {
		mapStreamStatusToAggr,
		isTerminalAggr,
		deriveStageDots,
		pillWorker,
		fmtElapsed,
		parsePillTs,
		derivePillTrust,
		deriveGateBadges,
		deriveResultFiles,
		buildSheetLog,
		pillAnimFor
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
		onclose
	}: {
		traceId: string;
		rows: StreamRow[];
		status: string;
		worker: string | null;
		brief: string | null;
		startedAtIso: string | null;
		durationLabel: string | null;
		reconciled?: boolean;
		onclose: () => void;
	} = $props();

	const aggr = $derived(mapStreamStatusToAggr(status));
	const terminal = $derived(isTerminalAggr(aggr));
	const stages = $derived(deriveStageDots(rows, aggr));
	const who = $derived(pillWorker(worker, traceId));
	const title = $derived((brief || '').trim() || 'Working on it');
	const gates = $derived(deriveGateBadges(rows));
	const files = $derived(deriveResultFiles(rows));
	const log = $derived(buildSheetLog(rows));

	// Logs collapsed by default in a single row (spec board); the row expands
	// in place to the full chronological list.
	let logOpen = $state(false);

	// Live elapsed ticker — same truth rules as the pill: only advances while
	// the run is in flight; at terminal the frozen server-truth durationLabel
	// takes over (no live digits lying about a finished run).
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

	const trust = $derived(derivePillTrust({ terminal, reconciled, startedAtIso, nowMs }));
	// Same truth-guarded selection as the pill, hosted at sheet scale (40px) —
	// the one surface with room for the state animation's actual detail.
	// pillAnimFor returns null for untrusted/stale runs; done/failed play once
	// and hold (loop=false), exactly the in-feed semantics.
	const anim = $derived(pillAnimFor({ status, aggr, stages, trust }));
	const checkLabel = $derived(
		trust === 'stale' ? 'stale — checking…' : trust === 'unverified' ? 'checking…' : null
	);
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
	const STEP_LABELS: Record<string, string> = {
		done: 'done',
		active: 'in progress',
		pending: 'waiting',
		skipped: 'skipped',
		blocked: 'blocked',
		'needs-you': 'needs you',
		failed: 'failed'
	};
	function stageName(key: string): string {
		return key.charAt(0).toUpperCase() + key.slice(1);
	}

	// Exit choreography. Scrim tap / X / Escape play the closing animation
	// (timeout-driven so reduced-motion or a swallowed animationend can never
	// strand an unclosable sheet — same fallback discipline as sheetDrag). A
	// drag dismissal arrives here AFTER the factory has already animated the
	// sheet down, so only the scrim fade remains visible.
	let closing = $state(false);
	let closeFired = false;
	function fireClose() {
		if (closeFired) return;
		closeFired = true;
		onclose();
	}
	function requestClose() {
		if (closing || closeFired) return;
		const reduced =
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reduced) {
			fireClose();
			return;
		}
		closing = true;
		setTimeout(fireClose, 380); // --dur-panel (360ms) + slack
	}

	const drag = createSheetDrag({ onDismiss: requestClose });

	// Portal to <body> — the feed sits under ancestors with backdrop-filter,
	// which (per CSS spec) create containing blocks for position:fixed
	// descendants and would clip the sheet (same reason as the Composer's
	// model-picker mobilePortal).
	function portal(node: HTMLElement): { destroy(): void } | void {
		if (typeof document === 'undefined') return;
		document.body.appendChild(node);
		return {
			destroy() {
				if (node.parentNode === document.body) node.remove();
			}
		};
	}

	// Escape-to-close + body scroll lock while open (ImageLightbox idiom —
	// without the lock, tap-and-drag on iOS leaks to the feed scroll behind).
	$effect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') requestClose();
		};
		document.addEventListener('keydown', onKey);
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.removeEventListener('keydown', onKey);
			document.body.style.overflow = prevOverflow;
		};
	});
</script>

<div
	class="rs-root"
	class:rs-closing={closing}
	role="dialog"
	aria-modal="true"
	aria-label="Run details — {title}"
	tabindex="-1"
	data-testid="run-sheet-root"
	use:portal
	onclick={requestClose}
	onkeydown={(e) => {
		// Only when the root itself has focus — bubbled Enter/Space from inner
		// controls (log toggle, file rows) must not dismiss the sheet.
		if (e.target !== e.currentTarget) return;
		if (e.key === 'Enter' || e.key === ' ') requestClose();
	}}
>
	<div class="rs-scrim" aria-hidden="true" data-testid="run-sheet-scrim"></div>

	<!-- Taps inside the sheet must not fall through to the scrim-dismiss. -->
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div
		class="rs-sheet"
		data-sheet
		data-testid="run-sheet"
		data-aggr={aggr}
		data-trust={trust}
		data-trace-id={traceId}
		onclick={(e) => e.stopPropagation()}
	>
		<!-- Drag zone: grabber + header. Swipe down here always dismisses. -->
		<div class="rs-handle" style="touch-action: none;" {...drag.handleProps}>
			<div class="rs-grabber" aria-hidden="true"></div>
			<header class="rs-header">
				{#if anim}
					<span class="rs-anim" data-testid="run-sheet-anim" aria-hidden="true">
						<WorkerStateAnim file={anim.file} loop={anim.loop} size={40} />
					</span>
				{/if}
				<span class="rs-worker" data-testid="run-sheet-worker" title={who.display}>
					{who.shortCode}
				</span>
				<h2 class="rs-title" data-testid="run-sheet-title">{title}</h2>
				<button
					type="button"
					class="rs-close"
					data-testid="run-sheet-close"
					aria-label="Close run details"
					onclick={requestClose}
				>
					<X size={15} />
				</button>
			</header>
			<div class="rs-statusline">
				<span class="rs-state rs-state--{aggr}" data-testid="run-sheet-state">
					{STATE_LABELS[aggr] ?? aggr}
				</span>
				{#if checkLabel}
					<!-- Truth guard (LOS-196): unverified/stale replaces the clock. -->
					<span class="rs-clock" data-testid="run-sheet-checking" data-trust={trust}>
						{checkLabel}
					</span>
				{:else if elapsedLabel}
					<span class="rs-clock" data-testid="run-sheet-elapsed">{elapsedLabel}</span>
				{/if}
			</div>
		</div>

		<!-- Scrollable body — native scroll; a downward drag dismisses only when
		     scrolled to the top (vaul shouldDrag via the shared factory). -->
		<div class="rs-body" style="touch-action: pan-y;" use:drag.bodyAction {...drag.bodyProps}>
			<!-- Step timeline — the same six honest stage dots as the pill. -->
			<section class="rs-section" data-testid="run-sheet-timeline" aria-label="Step timeline">
				<h3 class="rs-section-label">Steps</h3>
				{#each stages as s (s.key)}
					<div
						class="rs-step rs-step--{s.status}"
						data-testid="run-sheet-step"
						data-stage={s.key}
						data-status={s.status}
					>
						<span class="rs-step-dot rs-step-dot--{s.status}" aria-hidden="true"></span>
						<span class="rs-step-label">{stageName(s.key)}</span>
						<span class="rs-step-status">{STEP_LABELS[s.status] ?? s.status}</span>
					</div>
				{/each}
			</section>

			{#if gates.length > 0}
				<!-- Gate badges — only when a gate actually ran in the stream. -->
				<section class="rs-section" data-testid="run-sheet-gates" aria-label="Gates">
					<h3 class="rs-section-label">Gates</h3>
					<div class="rs-gates">
						{#each gates as g (g.kind)}
							<span
								class="rs-gate rs-gate--{g.verdict}"
								data-testid="run-sheet-gate"
								data-kind={g.kind}
								data-verdict={g.verdict}
							>
								{g.label}
							</span>
						{/each}
					</div>
				</section>
			{/if}

			{#if log.length > 0}
				<!-- Activity log — collapsed by default into a single row. -->
				<section class="rs-section" aria-label="Activity log">
					<h3 class="rs-section-label">Activity</h3>
					<button
						type="button"
						class="rs-log-row"
						data-testid="run-sheet-log-row"
						aria-expanded={logOpen}
						onclick={() => (logOpen = !logOpen)}
					>
						<span class="rs-log-count">{log.length} step{log.length === 1 ? '' : 's'}</span>
						<span class="rs-log-latest">{log[log.length - 1].text}</span>
						<ChevronDown size={13} class="rs-log-chevron {logOpen ? 'rs-log-chevron--open' : ''}" />
					</button>
					{#if logOpen}
						<div class="rs-log" data-testid="run-sheet-log">
							{#each log as entry (entry.seq)}
								<div
									class="rs-log-entry"
									data-testid="run-sheet-log-entry"
									data-action={entry.action}
								>
									<span class="rs-log-seq">#{entry.seq}</span>
									<span class="rs-log-text">{entry.text}</span>
								</div>
							{/each}
						</div>
					{/if}
				</section>
			{/if}

			{#if files.length > 0}
				<!-- Result files — ONLY when the stream shows files were written
				     (operator-locked truth guard). -->
				<section class="rs-section" data-testid="run-sheet-files" aria-label="Result files">
					<h3 class="rs-section-label">Files</h3>
					{#each files as f (f)}
						<div class="rs-file" data-testid="run-sheet-file">{f}</div>
					{/each}
				</section>
			{/if}
		</div>
	</div>
</div>

<style>
	.rs-root {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
	}

	.rs-scrim {
		position: absolute;
		inset: 0;
		background: var(--surface-overlay);
		animation: rs-fade-in var(--dur-panel) var(--ease-sheet) backwards;
	}
	.rs-closing .rs-scrim {
		animation: rs-fade-out var(--dur-panel) var(--ease-sheet) forwards;
	}

	.rs-sheet {
		position: relative;
		display: flex;
		flex-direction: column;
		max-height: 85dvh;
		overflow: hidden;
		border: 1px solid var(--line2);
		border-bottom: none;
		border-radius: var(--r-lg) var(--r-lg) 0 0;
		background: var(--surface-raised);
		box-shadow: var(--shadow-float);
		padding-bottom: max(env(safe-area-inset-bottom, 0px), 12px);
		will-change: transform;
		animation: rs-sheet-in var(--dur-long) var(--ease-sheet) backwards;
	}
	.rs-closing .rs-sheet {
		animation: rs-sheet-out var(--dur-panel) var(--ease-sheet) forwards;
	}

	.rs-handle {
		flex: none;
		padding: 6px 14px 10px;
		border-bottom: 1px solid var(--line);
	}
	.rs-grabber {
		width: 40px;
		height: 5px;
		margin: 2px auto 10px;
		border-radius: var(--r-pill);
		background: var(--line3);
	}

	.rs-anim {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
	}

	.rs-header {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.rs-worker {
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
	.rs-title {
		flex: 1 1 0;
		min-width: 0;
		margin: 0;
		font-size: var(--text-base);
		line-height: var(--leading-base);
		font-weight: var(--weight-medium);
		color: var(--t1);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.rs-close {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		margin-right: -6px;
		border: none;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--t3);
		cursor: pointer;
	}
	.rs-close:hover {
		color: var(--t1);
	}

	.rs-statusline {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 8px;
	}
	.rs-state {
		font-size: var(--text-xs);
		line-height: var(--leading-xs);
		font-weight: var(--weight-medium);
		border-radius: var(--r-pill);
		padding: 2px 10px;
		color: var(--t2);
		background: var(--surface-card);
		border: 1px solid var(--line2);
	}
	/* Status tinting — exclusively the locked --*-bg / --*-line pairs. */
	.rs-state--running {
		color: var(--live);
		background: var(--live-bg);
		border-color: var(--live-line);
	}
	.rs-state--needs-you,
	.rs-state--blocked {
		color: var(--amber);
		background: var(--amber-bg);
		border-color: var(--amber-line);
	}
	.rs-state--failed {
		color: var(--red);
		background: var(--red-bg);
		border-color: var(--red-line);
	}
	.rs-state--done {
		color: var(--green);
		background: var(--green-bg);
		border-color: var(--green-line);
	}
	/* Terminal lanes persist: stopped reads neutral-quiet, never failed-red. */
	.rs-state--stopped {
		opacity: 0.7;
	}

	.rs-clock {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		color: var(--t3);
		white-space: nowrap;
	}

	.rs-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 4px 14px 10px;
	}

	.rs-section {
		padding: 10px 0;
		border-bottom: 1px solid var(--line);
	}
	.rs-section:last-child {
		border-bottom: none;
	}
	.rs-section-label {
		margin: 0 0 8px;
		font-size: var(--text-xs);
		line-height: var(--leading-xs);
		font-weight: var(--weight-medium);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--t4);
	}

	/* ── Step timeline ── */
	.rs-step {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 30px;
	}
	.rs-step-dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: var(--r-pill);
		box-sizing: border-box;
	}
	.rs-step-dot--done {
		background: var(--ui);
	}
	.rs-step-dot--active {
		background: var(--live);
		animation: rs-breath var(--dur-ambient) var(--ease-standard) infinite;
	}
	.rs-step-dot--pending {
		background: var(--line3);
	}
	/* Skipped ≠ done: hollow ring vs filled dot. */
	.rs-step-dot--skipped {
		background: transparent;
		border: 1px solid var(--line3);
	}
	.rs-step-dot--failed {
		background: var(--red);
	}
	.rs-step-dot--needs-you {
		background: var(--amber);
		animation: rs-breath var(--dur-ambient-fast) var(--ease-standard) infinite;
	}
	.rs-step-dot--blocked {
		background: var(--amber);
	}

	.rs-step-label {
		flex: 1 1 0;
		font-size: var(--text-sm);
		line-height: var(--leading-sm);
		color: var(--t1);
	}
	.rs-step--pending .rs-step-label,
	.rs-step--skipped .rs-step-label {
		color: var(--t3);
	}
	.rs-step-status {
		font-size: var(--text-xs);
		line-height: var(--leading-xs);
		color: var(--t3);
	}
	.rs-step--active .rs-step-status {
		color: var(--live);
	}
	.rs-step--failed .rs-step-status {
		color: var(--red);
	}
	.rs-step--needs-you .rs-step-status,
	.rs-step--blocked .rs-step-status {
		color: var(--amber);
	}

	/* ── Gate badges ── */
	.rs-gates {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.rs-gate {
		font-size: var(--text-xs);
		line-height: var(--leading-xs);
		font-weight: var(--weight-medium);
		border-radius: var(--r-pill);
		padding: 3px 10px;
		color: var(--t2);
		background: var(--surface-card);
		border: 1px solid var(--line2);
	}
	.rs-gate--go {
		color: var(--green);
		background: var(--green-bg);
		border-color: var(--green-line);
	}
	.rs-gate--warn {
		color: var(--amber);
		background: var(--amber-bg);
		border-color: var(--amber-line);
	}
	.rs-gate--no-go {
		color: var(--red);
		background: var(--red-bg);
		border-color: var(--red-line);
	}

	/* ── Collapsed log row ── */
	.rs-log-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 36px;
		padding: 4px 0;
		border: none;
		background: transparent;
		text-align: left;
		font: inherit;
		color: var(--t2);
		cursor: pointer;
	}
	.rs-log-count {
		flex: none;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		color: var(--t3);
	}
	.rs-log-latest {
		flex: 1 1 0;
		min-width: 0;
		font-size: var(--text-sm);
		line-height: var(--leading-sm);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	:global(.rs-log-chevron) {
		flex: none;
		color: var(--t3);
		transition: transform var(--dur-fast) var(--ease-standard);
	}
	:global(.rs-log-chevron--open) {
		transform: rotate(180deg);
	}

	.rs-log {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-top: 4px;
	}
	.rs-log-entry {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-height: 24px;
	}
	.rs-log-seq {
		flex: none;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		color: var(--t4);
	}
	.rs-log-text {
		min-width: 0;
		font-size: var(--text-sm);
		line-height: var(--leading-sm);
		color: var(--t2);
		overflow-wrap: anywhere;
	}

	/* ── Result files ── */
	.rs-file {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		line-height: var(--leading-xs);
		color: var(--t2);
		padding: 4px 0;
		overflow-wrap: anywhere;
	}

	/* transform/opacity only — no layout or paint properties animate. The
	   exit keyframes declare only `to`, so they pick up from the current
	   transform (incl. a drag-dismissed inline translateY(100%)) without a
	   jump. */
	@keyframes rs-sheet-in {
		from {
			transform: translate3d(0, 100%, 0);
		}
		to {
			transform: translate3d(0, 0, 0);
		}
	}
	@keyframes rs-sheet-out {
		to {
			transform: translate3d(0, 100%, 0);
		}
	}
	@keyframes rs-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes rs-fade-out {
		to {
			opacity: 0;
		}
	}
	@keyframes rs-breath {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.rs-scrim,
		.rs-sheet,
		.rs-closing .rs-scrim,
		.rs-closing .rs-sheet {
			animation: none;
		}
		.rs-step-dot--active,
		.rs-step-dot--needs-you {
			animation: none;
		}
		:global(.rs-log-chevron) {
			transition: none;
		}
	}
</style>
