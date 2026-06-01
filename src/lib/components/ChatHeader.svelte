<script lang="ts">
	// Chat header — sidebar-toggle + home-anchor logo + target-repo chip
	// + model-picker chip, with their respective popovers.
	// Extracted from /chat as Task #7 PR 3 of the +page.svelte decomposition.
	//
	// Self-contained markup, but state crossing the boundary stays as props +
	// callbacks (no store). The parent owns all $state runes; bindable props
	// are used where the parent's global popover-close $effect needs to read
	// the value by name (`openChip`, `showModelOverrideModal`).
	//
	// The `selectedModelChoice` $derived stays in the parent (it reads
	// `operatorOverride`, `currentTier`, `providerOverride` from parent
	// scope); the resolved value is passed in as a prop. The MODEL_CHOICES
	// table is also owned by the parent and passed in — single source of
	// truth.
	//
	// ARIA labels (`Toggle Sessions Sidebar`, `Target repository`,
	// `Model picker`, `Return to Dashboard`), and the
	// `data-popover` / `data-popover-trigger` attributes are load-bearing —
	// the chat e2e suite and the parent's global popover effect select on
	// them. Do not change.

	import { base, resolve } from '$app/paths';
	import { Menu, ChevronDown, Check, Edit3 } from 'lucide-svelte';
	import { fly } from 'svelte/transition';
	import type { Workspace } from '../../routes/chat/+page.server';

	type Tier = 'chat' | 'planning' | 'deep' | 'local';
	type ProviderPref = 'anthropic' | 'gemini' | 'local' | null;
	type ModelChoice = {
		id: string;
		label: string;
		sublabel: string;
		tier: Tier | null;
		provider: ProviderPref;
	};

	let {
		selectedRepo,
		selectedWorkspace,
		workspaces,
		tierEmoji,
		lastModelUsed,
		selectedModelChoice,
		MODEL_CHOICES,
		openChip = $bindable(),
		showModelOverrideModal = $bindable(),
		ontoggleSidebar,
		onswitchRepo,
		onsetModelChoice,
		onopenWorkspaceContext,
		oncloseAllPopovers
	}: {
		selectedRepo: string;
		selectedWorkspace: Workspace | null | undefined;
		workspaces: Workspace[];
		tierEmoji: string;
		lastModelUsed: string;
		selectedModelChoice: ModelChoice;
		MODEL_CHOICES: ModelChoice[];
		openChip: null | 'repo' | 'thread';
		showModelOverrideModal: boolean;
		ontoggleSidebar: () => void;
		onswitchRepo: (name: string) => void;
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
			class="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.03] text-zinc-400 transition-all hover:bg-white/[0.07] hover:text-white active:scale-90 sm:h-9 sm:w-9"
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
				alt="Sully"
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
				class="flex h-9 max-w-[8.5rem] min-w-0 items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.04] px-3 font-sans text-xs text-zinc-300 backdrop-blur-md transition-all hover:bg-white/[0.08] hover:text-white active:scale-95"
				aria-label="Model picker"
				title="Pick a specific model or leave on Auto"
			>
				<span class="shrink-0">{tierEmoji}</span>
				<span class="min-w-0 truncate font-mono text-[10px] tracking-wide text-zinc-400"
					>{selectedModelChoice.id === 'auto'
						? lastModelUsed || 'Auto'
						: selectedModelChoice.label}</span
				>
				<ChevronDown size={10} class="shrink-0 text-zinc-500" />
			</button>

			{#if showModelOverrideModal}
				<div
					data-popover
					transition:fly={{ y: -8, duration: 180 }}
					class="fixed top-[calc(env(safe-area-inset-top,0px)+3.5rem)] right-2 left-2 z-50 mt-2 rounded-2xl border border-white/[0.08] bg-[#0e0e11]/85 py-1.5 shadow-2xl backdrop-blur-2xl min-[430px]:absolute min-[430px]:top-full min-[430px]:right-0 min-[430px]:left-auto min-[430px]:w-64 min-[430px]:max-w-[calc(100vw-1rem)]"
				>
					<div
						class="px-3 py-1 font-mono text-[9px] tracking-wider text-zinc-600 uppercase select-none"
					>
						Model
					</div>
					{#each MODEL_CHOICES as choice (choice.id)}
						<button
							type="button"
							onclick={() => onsetModelChoice(choice)}
							class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-zinc-900
								{selectedModelChoice.id === choice.id ? 'font-medium text-[#ff7eb3]' : 'text-zinc-300'}"
						>
							<span class="flex min-w-0 flex-col leading-tight">
								<span class="truncate text-xs">{choice.label}</span>
								<span class="truncate font-mono text-[9px] text-zinc-500">{choice.sublabel}</span>
							</span>
							{#if selectedModelChoice.id === choice.id}
								<Check size={11} class="shrink-0" />
							{/if}
						</button>
					{/each}
					<!-- Projects-light: edit Sully's standing context addendum.
					     Preserved from the old repo chip (Task #22) — auto-injects
					     into every send for this workspace. -->
					<button
						type="button"
						onclick={() => onopenWorkspaceContext()}
						class="mt-1 flex w-full items-center gap-2 border-t border-zinc-800/50 px-3 py-2 text-left text-[11px] text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-300"
					>
						<Edit3 size={11} aria-hidden="true" />
						<span class="min-w-0 truncate">Edit Sully's context</span>
					</button>
				</div>
			{/if}
		</div>
	</div>
</header>
