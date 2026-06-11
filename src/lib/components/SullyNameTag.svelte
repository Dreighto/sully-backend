<script lang="ts">
	// The "● Sully" name-tag pill — a rounded brand-colored chip with a radial-
	// gradient dot + a label, shown on assistant message headers, the thinking
	// indicator, and tool-call rows.
	//
	// LOS-204 leaf-site proof: the shell is now the SullyPill primitive (live
	// status-surface pair --live-bg / --live-line replaces the old ad-hoc
	// brand/[0.08] + brand/30 alpha tints — same family, token-disciplined).
	// The orb-gradient identity dot rides the pill's dot snippet; label
	// typography stays at the call site per the pill's "surface + shape only"
	// contract.
	import SullyPill from './sully/SullyPill.svelte';

	let { label }: { label: string } = $props();
</script>

<SullyPill variant="live" class="mb-1.5 font-sans text-[11px] font-semibold tracking-wide">
	{#snippet dot()}
		<span
			class="h-2 w-2 shrink-0 rounded-[var(--r-pill)]"
			style="background: var(--orb-grad); box-shadow: var(--shadow-accent);"
		></span>
	{/snippet}
	<span class="text-brand-soft">{label}</span>
</SullyPill>
