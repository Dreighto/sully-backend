<script lang="ts">
	// Chat header — sidebar-toggle + home-anchor logo + model-picker chip,
	// with its popover.
	// Extracted from /chat as Task #7 PR 3 of the +page.svelte decomposition.
	//
	// Self-contained markup, but state crossing the boundary stays as props +
	// callbacks (no store). The parent owns all $state runes; bindable props
	// are used where the parent's global popover-close $effect needs to read
	// the value by name (`showModelOverrideModal`).
	//
	// The `selectedModelChoice` $derived stays in the parent (it reads
	// `operatorOverride`, `currentTier`, `providerOverride` from parent
	// scope); the resolved value is passed in as a prop. The MODEL_CHOICES
	// table is also owned by the parent and passed in — single source of
	// truth.
	//
	// ARIA labels (`Toggle Sessions Sidebar`, `Sully — home`), and the
	// `data-popover` / `data-popover-trigger` attributes are load-bearing —
	// the chat e2e suite and the parent's global popover effect select on
	// them. Do not change.
	//
	// The model-picker button's aria-label is dynamic and prefixes the
	// visible text (e.g. `Auto — Model picker`, `Sonnet 4.6 — Model picker`)
	// to satisfy WCAG 2.5.3 (Label in Name); axe / Lighthouse flagged the
	// previous static `Model picker` label as a content-name mismatch.
	// Selectors should target `[data-popover-trigger]` instead of the
	// aria-label.

	import { base, resolve } from '$app/paths';
	import { Menu, ChevronDown, Check, Edit3 } from 'lucide-svelte';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { ModelChoice } from '$lib/types/chat-ui';

	let {
		tierEmoji,
		lastModelUsed,
		selectedModelChoice,
		MODEL_CHOICES,
		showModelOverrideModal = $bindable(),
		ontoggleSidebar,
		onsetModelChoice,
		onopenWorkspaceContext,
		oncloseAllPopovers
	}: {
		tierEmoji: string;
		lastModelUsed: string;
		selectedModelChoice: ModelChoice;
		MODEL_CHOICES: ModelChoice[];
		showModelOverrideModal: boolean;
		ontoggleSidebar: () => void;
		onsetModelChoice: (choice: ModelChoice) => void;
		onopenWorkspaceContext: () => void;
		oncloseAllPopovers: () => void;
	} = $props();
</script>

<header
	class="relative z-50 flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.05] bg-[#0b0b0d]/55 px-4 pt-3 pb-2 backdrop-blur-2xl select-none"
	style="padding-top: max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem));"
>
	<div class="flex shrink-0 items-center gap-1.5">
		<!-- Sidebar toggle button -->
		<button
			type="button"
			onclick={ontoggleSidebar}
			class="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.03] text-zinc-400 transition-all hover:bg-white/[0.07] hover:text-white active:scale-90 sm:h-9 sm:w-9 lg:hidden"
			aria-label="Toggle Sessions Sidebar"
			title="Toggle Sessions Sidebar"
		>
			<Menu size={16} />
		</button>

		<!-- Sully identity — her glossy "thought-drop" face + name -->
		<a
			href={resolve('/')}
			aria-label="Sully — home"
			class="ml-0.5 flex items-center gap-2 transition-opacity hover:opacity-80"
		>
			<img
				src="{base}/sully-mark.png"
				alt=""
				class="h-8 w-8 shrink-0 drop-shadow-[0_0_10px_rgba(236,45,120,0.5)]"
			/>
			<span class="font-sans text-sm font-semibold tracking-tight text-zinc-100">Sully</span>
		</a>
	</div>

	<!-- Brain / voice picker — the one control Sully needs up top. The
	     workspace context-editor (Projects-light) is preserved as a footer
	     item in this menu rather than a second redundant chip. -->
	<div class="flex min-w-0 shrink-0 items-center">
		<!-- Model Picker Badge -->
		<div class="relative min-w-0">
			<button
				type="button"
				data-popover-trigger
				onclick={() => {
					const next = !showModelOverrideModal;
					oncloseAllPopovers();
					showModelOverrideModal = next;
				}}
				class="flex min-h-[44px] max-w-[8.5rem] min-w-0 items-center gap-1.5 rounded-full border px-3 font-sans text-xs backdrop-blur-md transition-all active:scale-95 sm:h-9 sm:min-h-0 {showModelOverrideModal
					? 'border-[#ec2d78]/40 bg-[#ec2d78]/10 text-white shadow-[0_0_18px_rgba(236,45,120,0.15)]'
					: 'border-white/[0.07] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08] hover:text-white'}"
				aria-label={`${selectedModelChoice.id === 'auto' ? lastModelUsed || 'Auto' : selectedModelChoice.label} — Model picker`}
				title="Pick a specific model or leave on Auto"
			>
				<span class="shrink-0">{tierEmoji}</span>
				<span
					class="min-w-0 truncate font-sans text-[10px] tracking-wide {showModelOverrideModal
						? 'text-zinc-100'
						: 'text-zinc-400'}"
					>{selectedModelChoice.id === 'auto'
						? lastModelUsed || 'Auto'
						: selectedModelChoice.label}</span
				>
				<ChevronDown
					size={10}
					class="shrink-0 transition-transform duration-200 {showModelOverrideModal
						? 'rotate-180 text-[#ff7eb3]'
						: 'text-zinc-500'}"
				/>
			</button>

			{#if showModelOverrideModal}
				<!-- transform-origin anchors the bloom to the trigger chip so the
				     popover reads as growing OUT of the button it came from, not
				     dropping in from nowhere. cubicOut feels premium without the
				     cartoony overshoot of backOut. -->
				<div
					data-popover
					transition:scale={{ start: 0.94, duration: 220, easing: cubicOut, opacity: 0 }}
					style="transform-origin: top right;"
					class="fixed top-[calc(env(safe-area-inset-top,0px)+3.5rem)] right-2 left-2 z-50 mt-2 max-h-[calc(100dvh-6rem)] overflow-y-auto overscroll-contain rounded-2xl border border-white/[0.08] bg-[#0e0e11]/85 py-1 shadow-2xl backdrop-blur-2xl min-[430px]:absolute min-[430px]:top-full min-[430px]:right-0 min-[430px]:left-auto min-[430px]:w-64 min-[430px]:max-w-[calc(100vw-1rem)]"
				>
					<div
						class="px-3 pt-1.5 pb-0.5 font-sans text-[9px] tracking-wider text-zinc-600 uppercase select-none"
					>
						Model
					</div>
					{#each MODEL_CHOICES as choice (choice.id)}
						<button
							type="button"
							onclick={() => onsetModelChoice(choice)}
							class="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-1.5 text-left transition-all hover:bg-white/[0.04] active:scale-[0.985] active:bg-white/[0.07]
								{selectedModelChoice.id === choice.id ? 'font-medium text-[#ff7eb3]' : 'text-zinc-200'}"
						>
							<span class="flex min-w-0 flex-col leading-[1.15]">
								<span class="truncate text-[13px]">{choice.label}</span>
								<span class="truncate font-sans text-[10px] text-zinc-500">{choice.sublabel}</span>
							</span>
							{#if selectedModelChoice.id === choice.id}
								<Check size={12} class="shrink-0" />
							{/if}
						</button>
					{/each}
					<!-- Projects-light: edit Sully's standing context addendum.
					     Preserved from the old repo chip (Task #22) — auto-injects
					     into every send for this workspace. The two-line layout
					     was added 2026-06-01 after operator feedback "I have no
					     idea what this does"; the subtitle explains the function. -->
					<button
						type="button"
						onclick={() => onopenWorkspaceContext()}
						class="mt-1 flex min-h-[44px] w-full items-center gap-2.5 border-t border-white/[0.06] px-3 py-2 text-left transition-all hover:bg-white/[0.04] active:scale-[0.985]"
					>
						<Edit3 size={12} class="shrink-0 text-zinc-500" aria-hidden="true" />
						<span class="flex min-w-0 flex-col leading-[1.15]">
							<span class="truncate text-[11px] text-zinc-300">Edit Sully's context</span>
							<span class="truncate font-sans text-[9px] text-zinc-500/80"
								>Notes added to every message you send</span
							>
						</span>
					</button>
				</div>
			{/if}
		</div>
	</div>
</header>
