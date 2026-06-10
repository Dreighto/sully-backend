<script lang="ts">
	import WorkSurfaceCard from '$lib/components/WorkSurfaceCard.svelte';
	import type { Surface } from '$lib/types/workSurface';
	import { ChevronDown, Maximize2 } from 'lucide-svelte';
	import { slide } from 'svelte/transition';

	let {
		surface,
		oncollapse,
		onmoreDetail
	}: {
		surface: Surface;
		oncollapse?: () => void;
		onmoreDetail?: () => void;
	} = $props();
</script>

<div
	class="work-surface-inline-panel mx-auto w-full max-w-2xl"
	transition:slide={{ duration: 220 }}
>
	<div class="mb-1.5 flex items-center justify-between gap-2 px-0.5">
		<button
			type="button"
			class="inline-flex min-h-[44px] items-center gap-1 rounded-[var(--r-pill)] border border-border bg-surface/80 px-3 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground active:scale-[0.98]"
			onclick={oncollapse}
			aria-label="Collapse work surface"
		>
			<ChevronDown size={14} strokeWidth={2.25} />
			Collapse
		</button>
		<button
			type="button"
			class="inline-flex min-h-[44px] items-center gap-1 rounded-[var(--r-pill)] border border-border bg-surface/80 px-3 text-[11px] font-medium text-foreground transition-colors hover:bg-card active:scale-[0.98]"
			onclick={onmoreDetail}
			aria-label="Open full work surface detail"
		>
			<Maximize2 size={14} strokeWidth={2.25} />
			More detail
		</button>
	</div>
	<div class="work-surface-inline-scroll">
		<WorkSurfaceCard task={surface.task} footprint="expanded" />
	</div>
</div>

<style lang="postcss">
	.work-surface-inline-scroll {
		max-height: min(52dvh, 520px);
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		border-radius: var(--r-md);
	}
</style>
