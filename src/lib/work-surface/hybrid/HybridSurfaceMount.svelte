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
	import type { SeedSurface } from './hybrid-types';

	let { traceId }: { traceId: string } = $props();

	let surface = $state<SeedSurface | null>(null);
	let loadError = $state<string | null>(null);
	let pollHandle: ReturnType<typeof setInterval> | null = null;

	const TERMINAL: ReadonlySet<SeedSurface['aggr']> = new Set(['done', 'failed']);
	const POLL_MS = 2000;

	async function fetchOnce(): Promise<void> {
		try {
			const res = await fetch(`${base}/api/surface/${encodeURIComponent(traceId)}`);
			if (res.status === 404) {
				loadError = 'trace_not_found';
				return;
			}
			if (!res.ok) {
				loadError = `http_${res.status}`;
				return;
			}
			const data = (await res.json()) as SeedSurface;
			surface = data;
			loadError = null;
			if (TERMINAL.has(data.aggr) && pollHandle) {
				clearInterval(pollHandle);
				pollHandle = null;
			}
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'fetch_failed';
		}
	}

	onMount(() => {
		void fetchOnce();
		pollHandle = setInterval(() => {
			void fetchOnce();
		}, POLL_MS);
	});

	onDestroy(() => {
		if (pollHandle) {
			clearInterval(pollHandle);
			pollHandle = null;
		}
	});
</script>

{#if surface}
	<HybridDispatchCard {surface} />
{:else if loadError === 'trace_not_found'}
	<div class="text-xs text-zinc-500 italic">Surface not found for {traceId}</div>
{:else if loadError}
	<div class="text-xs text-rose-500">Surface error: {loadError}</div>
{:else}
	<div class="text-xs text-zinc-500 italic">Loading surface…</div>
{/if}
