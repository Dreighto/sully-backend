<script lang="ts">
	// Header model picker — compact chip + mobile sheet / desktop dropdown.
	// Extracted from Composer.svelte (Phase B flagship pass).

	import PickerIcon from './PickerIcon.svelte';
	import { humanizeModelId } from '$lib/chat/model-registry';
	import type { ModelChoice, ProviderPref } from '$lib/types/chat-ui';
	import { Check, ChevronDown, X } from 'lucide-svelte';
	import { cubicOut } from 'svelte/easing';
	import type { TransitionConfig } from 'svelte/transition';
	import { createSheetDrag } from '$lib/utils/sheetDrag.svelte';

	let {
		open = $bindable(false),
		selectedModelChoice,
		modelChoices,
		pickerProvider,
		lastModelUsed,
		onsetModelChoice,
		oncloseAllPopovers
	}: {
		open?: boolean;
		selectedModelChoice: ModelChoice;
		modelChoices: ModelChoice[];
		pickerProvider: ProviderPref;
		lastModelUsed: string;
		onsetModelChoice: (choice: ModelChoice) => void;
		oncloseAllPopovers: () => void;
	} = $props();

	const PANEL_MS = 380; // --dur-panel (360ms) + slack

	let closing = $state(false);
	let closeFired = false;
	let prevOpen = false;

	function isMobileSheet(): boolean {
		return typeof window !== 'undefined' && window.innerWidth < 1024;
	}

	function fireClose() {
		if (closeFired) return;
		closeFired = true;
		open = false;
		closing = false;
	}

	function requestClose() {
		if (closing || closeFired) return;
		const reduced =
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reduced || !isMobileSheet()) {
			fireClose();
			return;
		}
		closing = true;
		setTimeout(fireClose, PANEL_MS);
	}

	// Parent closeAllPopovers sets open=false directly — keep the layer mounted
	// long enough for the exit animation (portal destroy() otherwise wins the race).
	$effect(() => {
		if (prevOpen && !open && !closing && !closeFired && isMobileSheet()) {
			const reduced =
				typeof window !== 'undefined' &&
				window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			if (reduced) return;
			closing = true;
			setTimeout(() => {
				closing = false;
			}, PANEL_MS);
		}
		if (open) {
			closeFired = false;
		}
		prevOpen = open;
	});

	let layerOpen = $derived(open || closing);

	$effect(() => {
		if (!layerOpen || !isMobileSheet()) return;
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

	const modelDrag = createSheetDrag({
		onDismiss: requestClose,
		isEnabled: () => typeof window !== 'undefined' && window.innerWidth < 1024,
		externalExit: true
	});

	function mobilePortal(node: HTMLElement): { destroy(): void } | void {
		if (typeof document === 'undefined') return;
		document.body.appendChild(node);
		return {
			destroy() {
				if (node.parentNode === document.body) node.remove();
			}
		};
	}

	function desktopTransition(_node: Element): TransitionConfig {
		return {
			duration: 220,
			easing: cubicOut,
			css: (t) => {
				const scaleVal = 0.94 + 0.06 * t;
				return `opacity: ${t}; transform: scale(${scaleVal}); transform-origin: top center;`;
			}
		};
	}

	function toggleOpen() {
		const next = !open;
		oncloseAllPopovers();
		open = next;
	}

	function pickModel(choice: ModelChoice) {
		onsetModelChoice(choice);
		requestClose();
	}
</script>

<div class="relative min-w-0 max-w-[11rem] shrink-0">
	<button
		type="button"
		data-popover-trigger
		data-testid="model-picker-chip"
		onclick={toggleOpen}
		class="model-picker-chip flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-[var(--r-pill)] border px-2.5 font-sans transition-all active:scale-[0.96] {open
			? 'border-[var(--live-line)] bg-[var(--live-bg)] text-white'
			: 'border-[var(--glass-border)] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100'}"
		aria-label={selectedModelChoice.id === 'auto' && lastModelUsed
			? `Auto — currently ${humanizeModelId(lastModelUsed)} — Model picker`
			: `${selectedModelChoice.label} — Model picker`}
		aria-expanded={open}
		title="Pick a specific model or leave on Auto"
	>
		<span class="h-1.5 w-1.5 shrink-0 rounded-[var(--r-pill)] bg-[var(--accent)]" aria-hidden="true"></span>
		<PickerIcon provider={pickerProvider} size={14} />
		<span class="flex min-w-0 flex-col items-start leading-[1.1]">
			<span class="truncate text-[11px] font-medium tracking-wide">
				{selectedModelChoice.id === 'auto' ? 'Auto' : selectedModelChoice.label}
			</span>
			{#if selectedModelChoice.id === 'auto' && lastModelUsed}
				<span class="truncate text-[9px] tracking-normal text-zinc-500">
					{humanizeModelId(lastModelUsed)}
				</span>
			{/if}
		</span>
		<ChevronDown
			size={10}
			class="shrink-0 transition-transform duration-[var(--dur-med)] {open
				? 'rotate-180 text-zinc-200'
				: 'text-zinc-500'}"
		/>
	</button>

	{#if layerOpen}
		<div
			class="mpc-root lg:hidden"
			class:mpc-closing={closing}
			role="presentation"
			use:mobilePortal
			onclick={requestClose}
			onkeydown={(e) => {
				if (e.key === 'Escape') requestClose();
			}}
		>
			<div class="mpc-scrim" aria-hidden="true"></div>
			<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
			<div
				class="mpc-sheet sully-glass-popover"
				data-sheet
				data-popover
				role="dialog"
				aria-modal="true"
				aria-label="Choose a model"
				tabindex="-1"
				onclick={(e) => e.stopPropagation()}
			>
				<div class="shrink-0" style="touch-action: none;" {...modelDrag.handleProps}>
					<div
						class="mx-auto mt-1 mb-2 h-1.5 w-10 shrink-0 rounded-[var(--r-pill)] bg-white/20"
						aria-hidden="true"
					></div>
					<div class="flex items-center justify-between px-3 pt-1.5 pb-0.5 font-sans select-none">
						<span class="text-[9px] tracking-wider text-zinc-600 uppercase">Model</span>
						<button
							type="button"
							onclick={requestClose}
							class="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--r-pill)] text-zinc-500 transition-all hover:bg-white/[0.06] hover:text-zinc-200 active:scale-90"
							aria-label="Close model picker"
							title="Close"
						>
							<X size={14} />
						</button>
					</div>
				</div>
				<div
					class="overflow-y-auto overscroll-contain"
					style="touch-action: pan-y;"
					use:modelDrag.bodyAction
					{...modelDrag.bodyProps}
				>
					{#each modelChoices as choice (choice.id)}
						<button
							type="button"
							onclick={() => pickModel(choice)}
							class="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-1.5 text-left transition-all hover:bg-white/[0.04] active:scale-[0.985] active:bg-white/[0.07]
							{selectedModelChoice.id === choice.id ? 'font-medium text-white' : 'text-zinc-200'}"
						>
							<span class="flex min-w-0 items-center gap-2.5">
								<span
									class="flex h-6 w-6 shrink-0 items-center justify-center {selectedModelChoice.id ===
									choice.id
										? 'text-white'
										: 'text-zinc-400'}"
								>
									<PickerIcon provider={choice.provider} size={16} />
								</span>
								<span class="flex min-w-0 flex-col leading-[1.15]">
									<span class="truncate text-[13px]">{choice.label}</span>
									<span class="truncate font-sans text-[10px] text-zinc-500">{choice.sublabel}</span>
								</span>
							</span>
							{#if selectedModelChoice.id === choice.id}
								<Check size={12} class="shrink-0" />
							{/if}
						</button>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	{#if open}
		<div
			data-popover
			role="dialog"
			aria-modal="true"
			aria-label="Choose a model"
			transition:desktopTransition
			class="sully-glass-popover absolute top-full left-1/2 z-50 mt-2 hidden max-h-[calc(100dvh-6rem)] w-64 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-hidden rounded-[var(--r-lg)] border pt-1 pb-1 lg:flex"
		>
			<div class="flex items-center justify-between px-3 pt-1.5 pb-0.5 font-sans select-none">
				<span class="text-[9px] tracking-wider text-zinc-600 uppercase">Model</span>
				<button
					type="button"
					onclick={requestClose}
					class="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--r-pill)] text-zinc-500 transition-all hover:bg-white/[0.06] hover:text-zinc-200 active:scale-90"
					aria-label="Close model picker"
					title="Close"
				>
					<X size={14} />
				</button>
			</div>
			<div class="overflow-y-auto overscroll-contain">
				{#each modelChoices as choice (choice.id)}
					<button
						type="button"
						onclick={() => pickModel(choice)}
						class="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-1.5 text-left transition-all hover:bg-white/[0.04] active:scale-[0.985] active:bg-white/[0.07]
							{selectedModelChoice.id === choice.id ? 'font-medium text-white' : 'text-zinc-200'}"
					>
						<span class="flex min-w-0 items-center gap-2.5">
							<span
								class="flex h-6 w-6 shrink-0 items-center justify-center {selectedModelChoice.id ===
								choice.id
									? 'text-white'
									: 'text-zinc-400'}"
							>
								<PickerIcon provider={choice.provider} size={16} />
							</span>
							<span class="flex min-w-0 flex-col leading-[1.15]">
								<span class="truncate text-[13px]">{choice.label}</span>
								<span class="truncate font-sans text-[10px] text-zinc-500">{choice.sublabel}</span>
							</span>
						</span>
						{#if selectedModelChoice.id === choice.id}
							<Check size={12} class="shrink-0" />
						{/if}
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.mpc-root {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
	}

	.mpc-scrim {
		position: absolute;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		animation: mpc-fade-in var(--dur-panel) var(--ease-sheet) backwards;
	}
	.mpc-closing .mpc-scrim {
		animation: mpc-fade-out var(--dur-panel) var(--ease-sheet) forwards;
	}

	.mpc-sheet {
		position: relative;
		display: flex;
		max-height: 80dvh;
		flex-direction: column;
		overflow: hidden;
		border-bottom: none;
		border-radius: var(--r-lg) var(--r-lg) 0 0;
		padding-top: 0.5rem;
		padding-bottom: max(env(safe-area-inset-bottom, 0px), 0.5rem);
		will-change: transform;
		animation: mpc-sheet-in var(--dur-long) var(--ease-sheet) backwards;
	}
	.mpc-closing .mpc-sheet {
		animation: mpc-sheet-out var(--dur-panel) var(--ease-sheet) forwards;
	}

	@keyframes mpc-sheet-in {
		from {
			opacity: 0;
			transform: translate3d(0, 100%, 0);
		}
		to {
			opacity: 1;
			transform: translate3d(0, 0, 0);
		}
	}
	@keyframes mpc-sheet-out {
		to {
			opacity: 0;
			transform: translate3d(0, 100%, 0);
		}
	}
	@keyframes mpc-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes mpc-fade-out {
		to {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.mpc-scrim,
		.mpc-sheet {
			animation: none !important;
		}
	}
</style>
