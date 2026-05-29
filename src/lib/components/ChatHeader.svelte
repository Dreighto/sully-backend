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
	class="relative z-50 flex shrink-0 items-center justify-between px-4 pt-3 pb-2 select-none"
>
	<div class="flex items-center gap-1.5">
		<!-- Sidebar toggle button -->
		<button
			type="button"
			onclick={ontoggleSidebar}
			class="flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-800/80 bg-zinc-950/60 text-zinc-400 transition-all hover:text-white active:scale-90 sm:h-9 sm:w-9"
			aria-label="Toggle Sessions Sidebar"
			title="Toggle Sessions Sidebar"
		>
			<Menu size={16} />
		</button>

		<!-- Logo home anchor -->
		<a
			href={resolve('/')}
			aria-label="Return to Dashboard"
			class="ml-0.5 flex h-9 w-9 items-center justify-center transition-opacity hover:opacity-80"
		>
			<img src="{base}/favicon.png" alt="Companion" class="h-6 w-6" />
		</a>
	</div>

	<!-- Context badges dropdown container -->
	<div class="flex items-center gap-1.5">
		<!-- Repository selection chip -->
		<div class="relative">
			<button
				type="button"
				data-popover-trigger
				onclick={() => {
					const next = openChip === 'repo' ? null : 'repo';
					oncloseAllPopovers();
					openChip = next;
				}}
				class="flex min-h-[44px] items-center gap-1.5 rounded-full border border-zinc-800 bg-[#0e0e0e] px-3 py-1.5 font-sans text-xs text-zinc-300 shadow-sm transition-all hover:border-zinc-700 hover:bg-[#161616] hover:text-white sm:min-h-0"
				aria-label="Target repository"
			>
				<span>{selectedWorkspace?.emoji ?? '📁'}</span>
				<span>{selectedWorkspace?.display_name ?? selectedRepo}</span>
				<ChevronDown size={10} class="text-zinc-500" />
			</button>

			{#if openChip === 'repo'}
				<div
					data-popover
					class="absolute top-full right-0 z-50 mt-2 min-w-48 rounded-2xl border border-zinc-800 bg-[#0e0e0e] py-1.5 shadow-2xl"
				>
					<div
						class="px-3 py-1 font-mono text-[9px] tracking-wider text-zinc-600 uppercase select-none"
					>
						Target Directory
					</div>
					{#each workspaces as ws (ws.name)}
						<button
							type="button"
							onclick={() => onswitchRepo(ws.name)}
							class="flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-900
								{selectedRepo === ws.name ? 'font-medium text-cyan-400' : 'text-zinc-400'}"
						>
							<span class="flex items-center gap-2">
								<span>{ws.emoji}</span>
								<span>{ws.display_name}</span>
							</span>
							{#if selectedRepo === ws.name}
								<Check size={11} />
							{/if}
						</button>
					{/each}
					<!-- Projects-light: edit per-workspace system-prompt addendum.
					     Auto-injects into every chat send for this workspace.
					     Task #22. -->
					<button
						type="button"
						onclick={() => onopenWorkspaceContext()}
						class="mt-1 flex w-full items-center gap-2 border-t border-zinc-800/50 px-3 py-2 text-left text-[11px] text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-300"
					>
						<Edit3 size={11} aria-hidden="true" />
						<span>Edit context for {selectedWorkspace?.display_name ?? selectedRepo}</span>
					</button>
				</div>
			{/if}
		</div>

		<!-- Model Picker Badge -->
		<div class="relative">
			<button
				type="button"
				data-popover-trigger
				onclick={() => {
					const next = !showModelOverrideModal;
					oncloseAllPopovers();
					showModelOverrideModal = next;
				}}
				class="flex min-h-[44px] items-center gap-1.5 rounded-full border border-zinc-800 bg-[#0e0e0e] px-3 py-1.5 font-sans text-xs text-zinc-300 shadow-sm transition-all hover:border-zinc-700 hover:bg-[#161616] hover:text-white sm:min-h-0"
				aria-label="Model picker"
				title="Pick a specific model or leave on Auto"
			>
				<span>{tierEmoji}</span>
				<span class="max-w-[120px] truncate font-mono text-[10px] tracking-wide text-zinc-400"
					>{selectedModelChoice.id === 'auto'
						? lastModelUsed || 'Auto'
						: selectedModelChoice.label}</span
				>
				<ChevronDown size={10} class="text-zinc-500" />
			</button>

			{#if showModelOverrideModal}
				<div
					data-popover
					class="absolute top-full right-0 z-50 mt-2 min-w-56 rounded-2xl border border-zinc-800 bg-[#0e0e0e] py-1.5 shadow-2xl"
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
								{selectedModelChoice.id === choice.id ? 'font-medium text-purple-400' : 'text-zinc-300'}"
						>
							<span class="flex flex-col leading-tight">
								<span class="text-xs">{choice.label}</span>
								<span class="font-mono text-[9px] text-zinc-500">{choice.sublabel}</span>
							</span>
							{#if selectedModelChoice.id === choice.id}
								<Check size={11} class="shrink-0" />
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</header>
