<!-- src/lib/work-surface/hybrid/HybridWorkerCluster.svelte -->
<script lang="ts">
	import type { SeedWorker } from './hybrid-types';

	let { workers }: { workers: SeedWorker[] } = $props();

	const MAX_GLYPHS = 3;
	const shown = $derived(workers.slice(0, MAX_GLYPHS));
	const overflow = $derived(Math.max(0, workers.length - MAX_GLYPHS));
	const shortcodeLabel = $derived(shown.map((w) => w.shortcode).join(' · '));
</script>

<!--
  Single worker: [glyph][shortcode]
  2-3 workers:   [glyph][glyph][shortcodes CC·AGY]
  4+ workers:    [glyph]+[count]
-->
<div class="cluster" aria-label="Workers: {shortcodeLabel}">
	<div class="glyphs">
		{#each shown as worker, i}
			<svg
				width="15"
				height="15"
				viewBox="0 0 24 24"
				style="color: {worker.color}; {i > 0 ? 'margin-left: -3px;' : ''}"
				aria-hidden="true"
			>
				<use href="#{worker.iconId}" />
			</svg>
		{/each}
		{#if overflow > 0}
			<span class="overflow">+{overflow}</span>
		{/if}
	</div>
	<span class="codes">{shortcodeLabel}</span>
</div>

<style>
	.cluster {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: none;
	}
	.glyphs {
		display: flex;
		align-items: center;
	}
	.overflow {
		font-size: 10px;
		font-weight: 700;
		margin-left: 3px;
		color: var(--color-st-done);
	}
	.codes {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.05em;
		padding: 1px 5px;
		border-radius: var(--r-xs);
		background: var(--color-surface-raised);
		color: var(--color-st-done);
		white-space: nowrap;
	}
</style>
