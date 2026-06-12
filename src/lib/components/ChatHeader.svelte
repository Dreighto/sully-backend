<script lang="ts">
	// Chat header — sidebar toggle + Sully identity (left), model picker (center),
	// workspace-context entry (right).
	//
	// Phase B (flagship pass): model chip relocated from composer pill to header
	// center (hybrid canon B1).

	import { base, resolve } from '$app/paths';
	import { PanelLeft, NotebookPen } from 'lucide-svelte';
	import SullyButton from './sully/SullyButton.svelte';
	import ModelPickerChip from './ModelPickerChip.svelte';
	import type { ModelChoice, ProviderPref } from '$lib/types/chat-ui';

	let {
		workspaceContextOpen = $bindable(false),
		showModelOverrideModal = $bindable(false),
		selectedModelChoice,
		modelChoices,
		pickerProvider,
		lastModelUsed,
		ontoggleSidebar,
		onopenWorkspaceContext,
		onsetModelChoice,
		onclosePeerPopovers
	}: {
		workspaceContextOpen?: boolean;
		showModelOverrideModal?: boolean;
		selectedModelChoice: ModelChoice;
		modelChoices: ModelChoice[];
		pickerProvider: ProviderPref;
		lastModelUsed: string;
		ontoggleSidebar: () => void;
		onopenWorkspaceContext: () => void;
		onsetModelChoice: (choice: ModelChoice) => void;
		onclosePeerPopovers: () => void;
	} = $props();
</script>

<header
	class="relative z-50 grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-white/[0.05] bg-[#0b0b0d]/55 px-4 pt-3 pb-2 backdrop-blur-2xl select-none"
	style="padding-top: max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem));"
>
	<div class="flex min-w-0 items-center gap-1.5 justify-self-start">
		<SullyButton
			variant="quiet"
			size="sm"
			onclick={ontoggleSidebar}
			class="h-11 w-11 sm:h-9 sm:w-9 lg:hidden"
			style="--sully-btn-r: var(--r-pill)"
			aria-label="Toggle Sessions Sidebar"
			title="Toggle Sessions Sidebar"
		>
			<PanelLeft size={16} />
		</SullyButton>

		<a
			href={resolve('/')}
			aria-label="Sully — home"
			class="ml-0.5 flex items-center gap-2 transition-opacity hover:opacity-80"
		>
			<img
				src="{base}/sully-mark.png"
				alt=""
				class="h-8 w-8 shrink-0 drop-shadow-[0_0_10px_var(--accent-glow)]"
			/>
			<span class="hidden font-sans text-sm font-semibold tracking-tight text-zinc-100 sm:inline"
				>Sully</span
			>
		</a>
	</div>

	<div class="justify-self-center">
		<ModelPickerChip
			bind:open={showModelOverrideModal}
			{selectedModelChoice}
			modelChoices={modelChoices}
			{pickerProvider}
			{lastModelUsed}
			{onsetModelChoice}
			{onclosePeerPopovers}
		/>
	</div>

	<button
		type="button"
		onclick={() => onopenWorkspaceContext()}
		class="flex h-11 w-11 shrink-0 items-center justify-center justify-self-end rounded-[var(--r-pill)] transition-all active:scale-90 sm:h-9 sm:w-9 {workspaceContextOpen
			? 'bg-white/10 text-white'
			: 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'}"
		aria-label="Sully's workspace context"
		aria-haspopup="dialog"
		aria-expanded={workspaceContextOpen}
		title="Edit the notes Sully sees on every message"
	>
		<NotebookPen size={16} aria-hidden="true" />
	</button>
</header>
