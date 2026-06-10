<script lang="ts">
	// Per-workspace system-prompt addendum editor (Task #22 — Projects-light).
	// Extracted from /chat as Task #7 PR 1 of the +page.svelte decomposition.
	//
	// Self-contained: callers pass the open flag (bindable), the draft (bindable
	// — so debounce/character count still react in the parent), and a small
	// callback surface. The component does no I/O itself — parent owns the
	// fetch lifecycle (GET on open, PUT on save) so error handling stays
	// uniform with other parent network calls.

	import { Edit3, X } from 'lucide-svelte';
	import type { Workspace } from '../../routes/chat/+page.server';

	const MAX_CHARS = 4000;

	let {
		open = $bindable(),
		draft = $bindable(''),
		saving = false,
		loaded = true,
		loadError = false,
		selectedRepo = '',
		selectedWorkspace = null,
		onsave,
		onretry,
		onclose
	}: {
		open: boolean;
		draft: string;
		saving?: boolean;
		loaded?: boolean;
		loadError?: boolean;
		selectedRepo?: string;
		selectedWorkspace?: Workspace | null | undefined;
		onsave: () => void;
		onretry: () => void;
		onclose: () => void;
	} = $props();
</script>

{#if open}
	<div
		class="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center"
		style="padding-top: max(0.75rem, env(safe-area-inset-top, 0px));"
		onclick={(e) => {
			if (e.target === e.currentTarget) onclose();
		}}
		role="presentation"
	>
		<div
			class="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[520px] flex-col gap-3 overflow-y-auto rounded-t-[var(--r-lg)] border border-zinc-800 bg-[#0e0e0e] p-4 shadow-[var(--shadow-float)] sm:rounded-[var(--r-lg)]"
			style="max-height: calc(100dvh - max(1.5rem, env(safe-area-inset-top, 0px) + env(safe-area-inset-bottom, 0px) + 1rem)); padding-bottom: max(1rem, env(safe-area-inset-bottom, 0px));"
		>
			<div class="flex items-center gap-2">
				<Edit3 size={14} class="text-purple-400" aria-hidden="true" />
				<div class="flex-1 font-sans text-[11px] tracking-wider text-zinc-400 uppercase">
					Workspace context · {selectedWorkspace?.display_name ?? selectedRepo}
				</div>
				<button
					type="button"
					onclick={onclose}
					class="rounded-[var(--r-xs)] p-1 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-white"
					aria-label="Close"
				>
					<X size={14} aria-hidden="true" />
				</button>
			</div>
			<p class="text-[12px] text-zinc-500">
				Auto-injects into every chat send within
				<span class="font-sans text-zinc-300">{selectedRepo}</span>. Keep it focused — project
				intent, key files, gotchas. Saves retyping every new thread.
			</p>
			{#if loadError}
				<div
					class="flex items-center justify-between gap-2 rounded-[var(--r-sm)] border border-red-900/50 bg-red-950/30 px-3 py-2 text-[12px] text-red-300"
				>
					<span>Failed to load existing context. Save is disabled to avoid overwriting it.</span>
					<button
						type="button"
						onclick={onretry}
						class="rounded-[var(--r-xs)] border border-red-900/60 bg-red-950/40 px-2 py-1 font-sans text-[10px] tracking-wider text-red-200 uppercase hover:bg-red-900/40"
					>
						Retry
					</button>
				</div>
			{/if}
			<textarea
				bind:value={draft}
				maxlength={MAX_CHARS}
				rows="8"
				placeholder="e.g. Chat surface at src/routes/chat/+page.svelte. SDK endpoint /api/chat/sdk-stream. Test framework Playwright."
				disabled={loadError}
				class="w-full resize-none rounded-[var(--r-md)] border border-zinc-800 bg-zinc-950 px-3 py-2 font-sans text-[16px] leading-snug text-white placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none disabled:opacity-50"
				style="min-height: 160px;"
			></textarea>
			<div class="flex items-center justify-between gap-2">
				<div class="font-sans text-[10px] text-zinc-600">
					{draft.length} / {MAX_CHARS}
				</div>
				<div class="flex items-center gap-1.5">
					<button
						type="button"
						onclick={onclose}
						class="rounded-[var(--r-sm)] border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-sans text-[10px] tracking-wider text-zinc-400 uppercase transition-colors hover:bg-zinc-900 hover:text-white"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={onsave}
						disabled={saving || !loaded}
						class="rounded-[var(--r-sm)] bg-gradient-to-br from-purple-500 to-pink-500 px-3 py-1.5 font-sans text-[10px] tracking-wider text-white uppercase shadow-[var(--shadow-card)] transition-all hover:scale-105 active:scale-95 disabled:scale-100 disabled:opacity-50"
					>
						{saving ? 'Saving…' : 'Save'}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
