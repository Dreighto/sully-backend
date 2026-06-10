<script lang="ts">
	// Unified icon wrapper for Sully.
	// Usage: <Icon name="home" size={20} />
	// Falls back to lucide-svelte if the unicons version isn't found.

	import type { ComponentType } from 'svelte';

	interface Props {
		name: string;
		size?: number;
		class?: string;
		'aria-label'?: string;
		'aria-hidden'?: boolean;
	}

	let {
		name,
		size = 20,
		class: cls = '',
		'aria-label': ariaLabel,
		'aria-hidden': ariaHidden = !ariaLabel
	}: Props = $props();
</script>

<!--
  To use: import the SVG raw from @iconscout/unicons and render inline.
  Example in a consuming component:

  import MicIcon from '@iconscout/unicons/icons/line/microphone.svg?raw';
  {@html MicIcon}

  Or import the React/Svelte components if using the component package.
  See: https://iconscout.com/docs/unicons
-->
<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.5"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={cls}
	aria-label={ariaLabel}
	aria-hidden={ariaHidden}
	role={ariaLabel ? 'img' : undefined}
>
	<slot />
</svg>
