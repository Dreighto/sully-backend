<!--
  HybridSurfaceMount.svelte

  Inline mount for the C+B Hybrid Work Surface, used when the chat URL has
  `?hybrid-surface=1`. Fetches SeedSurface for a trace_id from
  /api/surface/[trace_id] and renders HybridDispatchCard.

  Poll-based for now (2s while running, stops on terminal state). A future
  iteration can subscribe to dispatch SSE for live updates — for now this is
  enough to validate the interaction model end-to-end on the phone.

  Sibling to Stage 1's HybridDispatchCard (Track A's DispatchCard stays the
  default; this only mounts when the flag is on).
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { base } from '$app/paths';
	import HybridDispatchCard from './HybridDispatchCard.svelte';
	import HybridDetailSheet from './HybridDetailSheet.svelte';
	import type { SeedSurface, SeedWorker, SeedFile, SeedPhase, SeedActivity } from './hybrid-types';

	let { traceId }: { traceId: string } = $props();

	let surface = $state<SeedSurface | null>(null);
	let loadError = $state<string | null>(null);
	let stale = $state(false); // showing last-good surface while refresh is failing
	let gaveUp = $state(false); // polling stopped after sustained failure
	let detailOpen = $state(false);

	let pollHandle: ReturnType<typeof setInterval> | null = null;
	let pollPeriod = 0;
	let destroyed = false;
	let inFlight = false;
	let consecutiveErrors = 0;

	const TERMINAL: ReadonlySet<SeedSurface['aggr']> = new Set(['done', 'failed', 'stopped']);
	const POLL_MS = 2000;
	const SLOW_POLL_MS = 10000; // back off to this after repeated failures
	const ERRORS_BEFORE_BACKOFF = 3;
	const ERRORS_BEFORE_GIVE_UP = 15; // ~stop hammering a clearly-down server

	// Per-element coercion (CDX #5, adversarial follow-up). The array-only guard
	// wasn't enough: a malformed ELEMENT (a file with no .path, a worker with no
	// .stepHistory) slips through and crashes a child ($derived f.path.split(),
	// activeWorker.stepHistory[...]). Coerce every element to a render-safe shape.
	function normWorker(w: any): SeedWorker {
		return {
			id: typeof w?.id === 'string' ? w.id : 'unknown',
			shortcode: typeof w?.shortcode === 'string' ? w.shortcode : '??',
			iconId: typeof w?.iconId === 'string' ? w.iconId : 'icon-claude',
			color: typeof w?.color === 'string' ? w.color : '#8a8a8a',
			status: (typeof w?.status === 'string' ? w.status : 'running') as SeedWorker['status'],
			currentStep: typeof w?.currentStep === 'string' ? w.currentStep : '',
			stepHistory: Array.isArray(w?.stepHistory)
				? w.stepHistory.filter((s: unknown) => typeof s === 'string')
				: []
		};
	}
	function normFile(f: any): SeedFile {
		return {
			path: typeof f?.path === 'string' ? f.path : 'unknown',
			status: (typeof f?.status === 'string' ? f.status : 'available') as SeedFile['status'],
			sizeBytes: typeof f?.sizeBytes === 'number' ? f.sizeBytes : undefined,
			modifiedAt: typeof f?.modifiedAt === 'string' ? f.modifiedAt : null
		};
	}
	function normPhase(p: any): SeedPhase {
		return {
			key: (typeof p?.key === 'string' ? p.key : 'read') as SeedPhase['key'],
			status: (typeof p?.status === 'string' ? p.status : 'pending') as SeedPhase['status'],
			startedAt: typeof p?.startedAt === 'string' ? p.startedAt : null,
			endedAt: typeof p?.endedAt === 'string' ? p.endedAt : null,
			reason: typeof p?.reason === 'string' ? p.reason : undefined
		};
	}
	function normActivity(a: any): SeedActivity {
		return {
			timestamp: typeof a?.timestamp === 'string' ? a.timestamp : '',
			action: typeof a?.action === 'string' ? a.action : '',
			description: typeof a?.description === 'string' ? a.description : '',
			target: typeof a?.target === 'string' ? a.target : null,
			phase: (typeof a?.phase === 'string' ? a.phase : null) as SeedActivity['phase']
		};
	}

	/**
	 * Shape guard (CDX critical #5). The API is same-origin and trusted, but a
	 * partial / garbled payload would crash child components that dereference
	 * collection elements. Reject anything without the load-bearing string
	 * fields; coerce every collection AND its elements to a render-safe shape.
	 */
	function normalizeSurface(x: unknown): SeedSurface | null {
		if (!x || typeof x !== 'object') return null;
		const o = x as Record<string, unknown>;
		if (typeof o.surfaceId !== 'string' || typeof o.aggr !== 'string') return null;
		return {
			surfaceId: o.surfaceId,
			title: typeof o.title === 'string' ? o.title : 'Working',
			aggr: o.aggr as SeedSurface['aggr'],
			workers: Array.isArray(o.workers) ? o.workers.map(normWorker) : [],
			phases: Array.isArray(o.phases) ? o.phases.map(normPhase) : [],
			files: Array.isArray(o.files) ? o.files.map(normFile) : [],
			activity: Array.isArray(o.activity) ? o.activity.map(normActivity) : [],
			needs: o.needs as SeedSurface['needs'],
			blockedBy: typeof o.blockedBy === 'string' ? o.blockedBy : undefined,
			createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
			elapsedDisplay: typeof o.elapsedDisplay === 'string' ? o.elapsedDisplay : ''
		};
	}

	function stopPolling(): void {
		if (pollHandle) {
			clearInterval(pollHandle);
			pollHandle = null;
		}
		pollPeriod = 0;
	}

	function arm(period: number): void {
		if (destroyed || pollPeriod === period) return;
		stopPolling();
		pollPeriod = period;
		pollHandle = setInterval(() => void fetchOnce(), period);
	}

	/** A refresh failed. Keep the last-good surface visible but flag it stale;
	 *  back off the poll after repeated failures; eventually give up. (#6) */
	function onRefreshFailure(code: string): void {
		consecutiveErrors++;
		if (surface) {
			stale = true; // keep showing last-good, mark reconnecting
		} else {
			loadError = code; // never had a surface → show the error state
		}
		if (consecutiveErrors >= ERRORS_BEFORE_GIVE_UP) {
			stopPolling();
			gaveUp = true; // copy switches to a non-retrying, tap-to-retry state
		} else if (consecutiveErrors >= ERRORS_BEFORE_BACKOFF) {
			arm(SLOW_POLL_MS);
		}
	}

	async function fetchOnce(): Promise<void> {
		if (inFlight || destroyed) return; // one request at a time (no overlap)
		inFlight = true;
		try {
			const res = await fetch(`${base}/api/surface/${encodeURIComponent(traceId)}`);
			if (destroyed) return;
			if (res.status === 404) {
				// Unknown trace. If we already had a surface, the trace vanished —
				// keep last-good + stale rather than blanking it.
				onRefreshFailure('trace_not_found');
				return;
			}
			if (!res.ok) {
				onRefreshFailure(`http_${res.status}`);
				return;
			}
			let data: unknown;
			try {
				data = await res.json();
			} catch {
				onRefreshFailure('bad_json');
				return;
			}
			if (destroyed) return;
			const normalized = normalizeSurface(data);
			if (!normalized) {
				onRefreshFailure('bad_shape');
				return;
			}
			// Success.
			surface = normalized;
			loadError = null;
			stale = false;
			consecutiveErrors = 0;
			if (TERMINAL.has(normalized.aggr)) {
				stopPolling();
			} else {
				arm(POLL_MS); // restore fast cadence if we'd backed off
			}
		} catch (err) {
			if (destroyed) return;
			onRefreshFailure(err instanceof Error ? err.message : 'fetch_failed');
		} finally {
			inFlight = false;
		}
	}

	/** Manual retry after give-up (the only way back once polling stopped). */
	function retryNow(): void {
		gaveUp = false;
		loadError = null;
		stale = false;
		consecutiveErrors = 0;
		void fetchOnce();
		arm(POLL_MS);
	}

	onMount(() => {
		void fetchOnce();
		arm(POLL_MS);
	});

	onDestroy(() => {
		destroyed = true;
		stopPolling();
	});
</script>

{#if surface}
	<div class="relative">
		{#if stale}
			<div
				class="surface-stale"
				data-testid="surface-stale"
				title={gaveUp ? 'Disconnected — tap to retry' : 'Reconnecting…'}
			>
				{#if gaveUp}
					<button class="surface-retry" type="button" onclick={retryNow}>Reconnect</button>
				{:else}
					<span class="surface-stale-dot" aria-hidden="true"></span>
				{/if}
			</div>
		{/if}
		<HybridDispatchCard {surface} onOpenDetail={() => (detailOpen = true)} />
		{#if detailOpen}
			<HybridDetailSheet {surface} onclose={() => (detailOpen = false)} />
		{/if}
	</div>
{:else if loadError === 'trace_not_found' && !gaveUp}
	<div class="text-xs text-zinc-500 italic">Surface not found for {traceId}</div>
{:else if gaveUp}
	<button class="surface-retry-row" type="button" data-testid="surface-retry" onclick={retryNow}>
		Surface unavailable{loadError ? ` (${loadError})` : ''} — tap to retry
	</button>
{:else if loadError}
	<div class="text-xs text-rose-500">Surface unavailable ({loadError}) — retrying…</div>
{:else}
	<div class="text-xs text-zinc-500 italic">Loading surface…</div>
{/if}

<style>
	.surface-stale {
		position: absolute;
		top: 6px;
		right: 6px;
		z-index: 2;
	}
	.surface-retry {
		font-size: 11px;
		padding: 3px 8px;
		border-radius: var(--r-xs);
		border: 1px solid var(--color-st-needs, #c9a34e);
		background: color-mix(in srgb, var(--color-st-needs, #c9a34e) 14%, transparent);
		color: var(--color-st-needs, #c9a34e);
		cursor: pointer;
	}
	.surface-retry-row {
		width: 100%;
		text-align: left;
		font-size: 12px;
		color: var(--color-st-needs, #c9a34e);
		background: none;
		border: 1px dashed color-mix(in srgb, var(--color-st-needs, #c9a34e) 40%, transparent);
		border-radius: var(--r-sm);
		padding: 8px 12px;
		cursor: pointer;
	}
	.surface-stale-dot {
		display: block;
		width: 7px;
		height: 7px;
		border-radius: var(--r-pill);
		background: var(--color-st-needs, #c9a34e);
		pointer-events: none;
		animation: stale-pulse 1.2s ease-in-out infinite;
	}
	@keyframes stale-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.25;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.surface-stale-dot {
			animation: none;
		}
	}
</style>
