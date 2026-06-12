<!--
  SullySheet — shared bottom-sheet primitive (Phase A flagship pass).

  Motion matches RunSheet: --ease-sheet, transform/opacity only, portal to body,
  swipe-down dismiss, reduced-motion instant close. Use for message actions,
  model picker on mobile, etc.
-->
<script lang="ts">
	import { createSheetDrag } from '$lib/utils/sheetDrag.svelte';

	let {
		open = $bindable(false),
		ariaLabel = 'Actions',
		onclose,
		children
	}: {
		open?: boolean;
		ariaLabel?: string;
		onclose?: () => void;
		children?: import('svelte').Snippet;
	} = $props();

	let closing = $state(false);
	let closeFired = false;

	function fireClose() {
		if (closeFired) return;
		closeFired = true;
		open = false;
		onclose?.();
	}

	function requestClose() {
		if (closing || closeFired) return;
		const reduced =
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reduced) {
			fireClose();
			return;
		}
		closing = true;
		setTimeout(fireClose, 380);
	}

	const drag = createSheetDrag({ onDismiss: requestClose });

	function portal(node: HTMLElement): { destroy(): void } | void {
		if (typeof document === 'undefined') return;
		document.body.appendChild(node);
		return {
			destroy() {
				if (node.parentNode === document.body) node.remove();
			}
		};
	}

	$effect(() => {
		if (!open) {
			closing = false;
			closeFired = false;
			return;
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') requestClose();
		};
		document.addEventListener('keydown', onKey);
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.removeEventListener('keydown', onKey);
			document.body.style.overflow = prevOverflow;
		};
	});
</script>

{#if open}
	<div
		class="ss-root"
		class:ss-closing={closing}
		role="dialog"
		aria-modal="true"
		aria-label={ariaLabel}
		tabindex="-1"
		data-testid="sully-sheet-root"
		use:portal
		onclick={requestClose}
		onkeydown={(e) => {
			if (e.target !== e.currentTarget) return;
			if (e.key === 'Enter' || e.key === ' ') requestClose();
		}}
	>
		<div class="ss-scrim" aria-hidden="true" data-testid="sully-sheet-scrim"></div>
		<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
		<div
			class="ss-sheet"
			data-sheet
			data-testid="sully-sheet"
			onclick={(e) => e.stopPropagation()}
		>
			<div class="ss-handle" style="touch-action: none;" {...drag.handleProps}>
				<div class="ss-grabber" aria-hidden="true"></div>
			</div>
			<div class="ss-body" style="touch-action: pan-y;" use:drag.bodyAction {...drag.bodyProps}>
				{@render children?.()}
			</div>
		</div>
	</div>
{/if}

<style>
	.ss-root {
		position: fixed;
		inset: 0;
		z-index: 75;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
	}

	.ss-scrim {
		position: absolute;
		inset: 0;
		background: var(--surface-overlay);
		animation: ss-fade-in var(--dur-panel) var(--ease-sheet) backwards;
	}
	.ss-closing .ss-scrim {
		animation: ss-fade-out var(--dur-panel) var(--ease-sheet) forwards;
	}

	.ss-sheet {
		position: relative;
		display: flex;
		flex-direction: column;
		max-height: 70dvh;
		overflow: hidden;
		border: 1px solid var(--glass-border);
		border-bottom: none;
		border-radius: var(--r-lg) var(--r-lg) 0 0;
		background: var(--glass-bg);
		-webkit-backdrop-filter: blur(20px) saturate(1.35);
		backdrop-filter: blur(20px) saturate(1.35);
		box-shadow: var(--shadow-float);
		padding-bottom: max(env(safe-area-inset-bottom, 0px), 12px);
		will-change: transform;
		animation: ss-sheet-in var(--dur-long) var(--ease-sheet) backwards;
	}
	.ss-closing .ss-sheet {
		animation: ss-sheet-out var(--dur-panel) var(--ease-sheet) forwards;
	}

	.ss-grabber {
		width: 36px;
		height: 4px;
		margin: 10px auto 4px;
		border-radius: var(--r-pill);
		background: rgba(255, 255, 255, 0.18);
	}

	.ss-body {
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}

	@keyframes ss-sheet-in {
		from {
			transform: translate3d(0, 100%, 0);
		}
		to {
			transform: translate3d(0, 0, 0);
		}
	}
	@keyframes ss-sheet-out {
		to {
			transform: translate3d(0, 100%, 0);
		}
	}
	@keyframes ss-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes ss-fade-out {
		to {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ss-scrim,
		.ss-sheet,
		.ss-closing .ss-scrim,
		.ss-closing .ss-sheet {
			animation: none;
		}
	}
</style>
