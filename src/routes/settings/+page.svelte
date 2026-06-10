<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { normalizeAutonomy, type Autonomy } from '$lib/chat/autonomy';

	let autonomy = $state<Autonomy>('ask');
	let meter = $state<{
		count: number;
		wallClockSeconds: number;
		used: number;
		cap: number;
		enabled?: boolean;
	} | null>(null);

	const modes: { id: Autonomy; label: string }[] = [
		{ id: 'ask', label: 'Ask' },
		{ id: 'auto-safe', label: 'Auto-for-safe' },
		{ id: 'full-auto', label: 'Full-auto' }
	];

	function setAutonomy(m: Autonomy) {
		autonomy = m;
		try {
			localStorage.setItem('companion-autonomy', m);
		} catch {
			/* ignore */
		}
	}

	onMount(async () => {
		try {
			autonomy = normalizeAutonomy(localStorage.getItem('companion-autonomy'));
		} catch {
			/* ignore */
		}
		try {
			const r = await fetch(resolve('/api/chat/dispatch/meter'));
			if (r.ok) meter = await r.json();
		} catch {
			/* ignore */
		}
	});

	const mmss = $derived(
		meter ? `${Math.floor(meter.wallClockSeconds / 60)}m ${meter.wallClockSeconds % 60}s` : '—'
	);
</script>

<div class="mx-auto max-w-md px-4 py-6" style="padding-top: env(safe-area-inset-top);">
	<h1 class="mb-4 text-lg font-semibold text-fuchsia-200">Settings</h1>

	<section class="mb-6">
		<h2 class="mb-2 text-[13px] text-fuchsia-200/70">Autonomy</h2>
		<div class="inline-flex rounded-[var(--r-pill)] border border-fuchsia-400/25 bg-black/30 p-1">
			{#each modes as mode (mode.id)}
				<button
					class="rounded-[var(--r-pill)] px-3 py-1 text-[12px] transition-all active:scale-95 {autonomy ===
					mode.id
						? 'bg-fuchsia-500/90 text-white'
						: 'text-fuchsia-200/70'}"
					onclick={() => setAutonomy(mode.id)}
				>
					{mode.label}
				</button>
			{/each}
		</div>
	</section>

	<section>
		<h2 class="mb-2 text-[13px] text-fuchsia-200/70">Dispatch meter (today)</h2>
		{#if meter?.enabled === false}
			<p class="text-[12px] text-fuchsia-200/50">Dispatch is disabled.</p>
		{:else if meter}
			<p class="text-[12px] text-fuchsia-100/80">
				{meter.count} dispatches · {mmss} worker wall-clock · {meter.used}/{meter.cap} cap
			</p>
		{:else}
			<p class="text-[12px] text-fuchsia-200/50">Loading…</p>
		{/if}
	</section>
</div>
