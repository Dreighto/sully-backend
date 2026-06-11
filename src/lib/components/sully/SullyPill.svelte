<script lang="ts">
	// SullyPill — stage-2 primitive (LOS-204, locked spec v1.0 §5).
	//
	// Baseline (neutral) is the work-object thread pill: --thread-pill-bg /
	// --thread-pill-border. Status variants use the --*-bg / --*-line
	// status-surface pairs ONLY — the single sanctioned way to tint a container
	// by state (never raw accent/semantic colors at ad-hoc alphas).
	//
	// Live dot: `dot` accepts `true` for the default --live dot, or a Snippet
	// for a custom dot (e.g. the orb-gradient identity dot). ACCENT BUDGET:
	// --live appears only when something is actually happening — at most ~3
	// live moments per screen. A pill that is not live gets no dot.
	//
	// The pill owns surface + shape only; typography inherits, so call sites
	// keep their text utilities (size/weight/face/color on child content).
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	type Variant = 'neutral' | 'live' | 'green' | 'amber' | 'red' | 'blue';

	interface Props extends HTMLAttributes<HTMLSpanElement> {
		variant?: Variant;
		dot?: Snippet | boolean;
		children?: Snippet;
	}

	let {
		variant = 'neutral',
		dot = false,
		children,
		class: className = '',
		...rest
	}: Props = $props();
</script>

<span
	class="sully-pill {className}"
	class:sully-pill--live={variant === 'live'}
	class:sully-pill--green={variant === 'green'}
	class:sully-pill--amber={variant === 'amber'}
	class:sully-pill--red={variant === 'red'}
	class:sully-pill--blue={variant === 'blue'}
	data-variant={variant}
	{...rest}
>
	{#if typeof dot === 'function'}
		{@render dot()}
	{:else if dot}
		<span class="sully-pill__dot" data-live="true"></span>
	{/if}
	{@render children?.()}
</span>

<style>
	.sully-pill {
		display: inline-flex;
		width: fit-content;
		align-items: center;
		gap: 6px;
		padding: 2px 10px;
		border: 1px solid var(--thread-pill-border);
		border-radius: var(--r-pill);
		background: var(--thread-pill-bg);
		color: var(--t2);
		user-select: none;
	}

	.sully-pill--live {
		background: var(--live-bg);
		border-color: var(--live-line);
		color: var(--accent);
	}

	.sully-pill--green {
		background: var(--green-bg);
		border-color: var(--green-line);
		color: var(--green);
	}

	.sully-pill--amber {
		background: var(--amber-bg);
		border-color: var(--amber-line);
		color: var(--amber);
	}

	.sully-pill--red {
		background: var(--red-bg);
		border-color: var(--red-line);
		color: var(--red);
	}

	.sully-pill--blue {
		background: var(--blue-bg);
		border-color: var(--blue-line);
		color: var(--blue);
	}

	.sully-pill__dot {
		width: 8px;
		height: 8px;
		flex-shrink: 0;
		border-radius: var(--r-pill);
		background: var(--live);
	}
</style>
