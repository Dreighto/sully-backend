<script lang="ts">
	// SullyCard — stage-2 primitive (LOS-204, locked spec v1.0 §5).
	//
	// The shell only: --surface-card on --line at --r-lg with --shadow-card;
	// `raised` steps up to --surface-raised + --shadow-float. Padding and
	// inner layout belong to the call site (utility classes via `class`).
	//
	// Motion: NO .sully-smooth here — full-width panel rule (transitioning
	// box-shadow/background-color on large surfaces costs frames on the iOS
	// WebView). The only sanctioned entrance is the global .sully-panel-enter
	// keyframe (transform/opacity, compositor-only), opted in via `enter`.
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	interface Props extends HTMLAttributes<HTMLDivElement> {
		raised?: boolean;
		enter?: boolean;
		children?: Snippet;
	}

	let { raised = false, enter = false, children, class: className = '', ...rest }: Props = $props();
</script>

<div
	class="sully-card {className}"
	class:sully-card--raised={raised}
	class:sully-panel-enter={enter}
	data-raised={raised ? 'true' : undefined}
	{...rest}
>
	{@render children?.()}
</div>

<style>
	.sully-card {
		background: var(--surface-card);
		border: 1px solid var(--line);
		border-radius: var(--r-lg);
		box-shadow: var(--shadow-card);
	}

	.sully-card--raised {
		background: var(--surface-raised);
		box-shadow: var(--shadow-float);
	}
</style>
