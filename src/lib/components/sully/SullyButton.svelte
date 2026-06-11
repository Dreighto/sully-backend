<script lang="ts">
	// SullyButton — stage-2 primitive (LOS-204, locked spec v1.0 §5).
	//
	// Variants:
	//   primary     — --grad fill + --on-accent text. Counts against the accent
	//                 budget (≤ ~3 --live/accent moments per screen).
	//   quiet       — chrome under --ui discipline: transparent surface, quiet
	//                 gray, never accent-colored.
	//   destructive — the --red-* status-surface pair (the ONLY sanctioned way
	//                 to tint a container by state — no ad-hoc alpha tints).
	//
	// Motion: .sully-smooth transitions (sanctioned for small interactive
	// elements only — never panels/sheets); press acknowledgment is
	// --dur-instant via transform ONLY (compositor-safe).
	//
	// Shape escape hatch: border-radius reads --sully-btn-r before the size
	// default (--r-sm / --r-md), so icon-only call sites can go fully round
	// with `style="--sully-btn-r: var(--r-pill)"` — locked tokens only, no
	// new radii.
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	interface Props extends HTMLButtonAttributes {
		variant?: 'primary' | 'quiet' | 'destructive';
		size?: 'sm' | 'md';
		children?: Snippet;
	}

	let {
		variant = 'primary',
		size = 'md',
		type = 'button',
		children,
		class: className = '',
		...rest
	}: Props = $props();
</script>

<button
	{type}
	class="sully-btn sully-smooth {className}"
	class:sully-btn--primary={variant === 'primary'}
	class:sully-btn--quiet={variant === 'quiet'}
	class:sully-btn--destructive={variant === 'destructive'}
	class:sully-btn--sm={size === 'sm'}
	class:sully-btn--md={size === 'md'}
	data-variant={variant}
	data-size={size}
	{...rest}
>
	{@render children?.()}
</button>

<style>
	.sully-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 1px solid transparent;
		font-family: var(--font-body);
		font-weight: var(--weight-semibold);
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		user-select: none;
	}

	.sully-btn--sm {
		padding: 6px 10px;
		border-radius: var(--sully-btn-r, var(--r-sm));
		font-size: var(--text-xs);
		line-height: var(--leading-xs);
	}

	.sully-btn--md {
		padding: 10px 14px;
		border-radius: var(--sully-btn-r, var(--r-md));
		font-size: var(--text-sm);
		line-height: var(--leading-sm);
	}

	.sully-btn--primary {
		background: var(--grad);
		color: var(--on-accent);
	}

	.sully-btn--quiet {
		background: transparent;
		color: var(--ui);
	}

	.sully-btn--quiet:hover {
		background: var(--line);
		color: var(--t2);
	}

	.sully-btn--destructive {
		background: var(--red-bg);
		border-color: var(--red-line);
		color: var(--red);
	}

	.sully-btn:focus-visible {
		outline: none;
		box-shadow: var(--focus);
	}

	/* Press acknowledgment — transform only, --dur-instant down-stroke;
	   release relaxes back through .sully-smooth's --dur-med. */
	.sully-btn:active:not(:disabled) {
		transform: scale(0.96);
		transition-duration: var(--dur-instant);
	}

	.sully-btn:disabled {
		opacity: 0.45;
		cursor: default;
	}
</style>
