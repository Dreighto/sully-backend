<script lang="ts">
	// Threads sidebar — pinned/active thread list + rename/archive/delete/pin controls.
	// Extracted from /chat as Task #7 PR 2 of the +page.svelte decomposition.
	//
	// Self-contained markup, but state crossing the boundary stays as props +
	// callbacks (no store). The parent owns all $state runes; bindable props
	// are used where the parent's global popover-close $effect needs to read
	// the value by name (`showArchived`, `renamingFor`, `renameDraft`,
	// `threadMenuOpenFor`).
	//
	// ARIA labels, the <aside> landmark tag, and the data-popover /
	// data-popover-trigger attributes are load-bearing — the chat e2e suite
	// and the parent's global popover effect select on them. Do not change.

	import { base } from '$app/paths';
	import {
		X,
		Compass,
		Pin,
		Moon,
		Hash,
		MoreVertical,
		Edit3,
		Archive,
		ArchiveRestore,
		Trash2,
		Eraser
	} from 'lucide-svelte';

	type Thread = {
		thread_id: string;
		title: string;
		archived: boolean;
		pinned: boolean;
		message_count: number;
		latest_ts?: string;
	};

	let {
		threads,
		activeThread,
		sidebarOpen = $bindable(),
		showArchived = $bindable(),
		renamingFor = $bindable(),
		renameDraft = $bindable(),
		threadMenuOpenFor = $bindable(),
		onswitchThread,
		onnewThread,
		oncloseSidebar,
		oncommitRename,
		oncancelRename,
		ontogglePin,
		ontoggleArchive,
		ondeleteThread,
		onopenRename,
		onclearAll,
		coreLabel = 'LogueOS-Console'
	}: {
		threads: Thread[];
		activeThread: string;
		sidebarOpen: boolean;
		showArchived: boolean;
		renamingFor: string | null;
		renameDraft: string;
		threadMenuOpenFor: string | null;
		onswitchThread: (id: string) => void;
		onnewThread: () => void;
		oncloseSidebar: () => void;
		oncommitRename: (id: string) => void;
		oncancelRename: () => void;
		ontogglePin: (thread: Thread) => void;
		ontoggleArchive: (thread: Thread) => void;
		ondeleteThread: (thread: Thread) => void;
		onopenRename: (thread: Thread) => void;
		onclearAll: () => void;
		/** Footer "CORE:" pill label — fork-aware (companion vs console). */
		coreLabel?: string;
	} = $props();
</script>

{#if sidebarOpen}
	<!-- Back-drop overlay for mobile -->
	<button
		type="button"
		onclick={oncloseSidebar}
		class="fixed inset-0 z-[55] bg-black/60 backdrop-blur-sm lg:hidden"
		aria-label="Close sidebar"
	></button>
{/if}

<aside
	class="fixed top-0 bottom-0 left-0 z-[60] flex w-72 flex-col border-r border-zinc-800/60 bg-[#090909]/98 shadow-[4px_0_40px_rgba(0,0,0,0.6)] backdrop-blur-2xl will-change-transform lg:static lg:z-auto lg:translate-x-0"
	style="transition: transform 320ms cubic-bezier(0.22,0.61,0.36,1), opacity 280ms cubic-bezier(0.22,0.61,0.36,1), width 280ms cubic-bezier(0.22,0.61,0.36,1); transform: {sidebarOpen
		? 'translateX(0)'
		: 'translateX(-100%)'}"
>
	<!-- Sidebar Header — padded below the dynamic island / safe area -->
	<div
		class="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 pb-3"
		style="padding-top: max(1.25rem, calc(env(safe-area-inset-top, 0px) + 1rem));"
	>
		<div class="flex items-center gap-2.5">
			<div
				class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
				style="background: radial-gradient(circle at 30% 25%, #ff8fc0, #ec2d78 55%, #c4186a); box-shadow: 0 0 12px rgba(236,45,120,0.45);"
			>
				<Moon size={13} class="text-white" strokeWidth={2.5} />
			</div>
			<span class="font-sans text-[13px] font-semibold tracking-tight text-zinc-200">Sully</span>
		</div>
		<div class="flex items-center gap-1">
			<button
				type="button"
				onclick={onnewThread}
				class="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.04] text-zinc-400 transition-all hover:bg-white/[0.08] hover:text-zinc-200 active:scale-90 sm:h-7 sm:w-7"
				title="New conversation"
				aria-label="New thread"
			>
				<Compass size={14} />
			</button>
			<button
				type="button"
				onclick={oncloseSidebar}
				class="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.04] text-zinc-400 transition-all hover:text-white active:scale-90 sm:h-7 sm:w-7 lg:hidden"
				aria-label="Close sidebar"
			>
				<X size={14} />
			</button>
		</div>
	</div>

	<!-- Threads Scroll Area -->
	<div class="flex flex-1 flex-col overflow-y-auto p-2">
		<!-- Toolbar — Show archived toggle + Clear All -->
		<div class="mb-1 flex items-center justify-between px-2 py-1">
			<button
				type="button"
				onclick={() => (showArchived = !showArchived)}
				class="flex h-7 items-center gap-1.5 rounded-lg px-2 font-sans text-[10px] text-zinc-500 transition-all hover:bg-white/[0.04] hover:text-zinc-300 active:scale-95"
				title={showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
			>
				<Archive size={10} />
				<span>{showArchived ? 'Hide archived' : 'Show archived'}</span>
			</button>
			<button
				type="button"
				onclick={onclearAll}
				class="flex h-7 items-center gap-1.5 rounded-lg px-2 font-sans text-[10px] text-zinc-600 transition-all hover:bg-red-950/30 hover:text-red-400 active:scale-95"
				title="Archive and delete every thread"
			>
				<Eraser size={10} />
				<span>Clear all</span>
			</button>
		</div>

		{#if threads.length === 0}
			<div class="px-3 py-4 text-center font-sans text-[10px] text-zinc-600">No sessions yet</div>
		{:else}
			<div class="space-y-1">
				{#each threads
					.filter((t) => showArchived || !t.archived)
					.slice()
					.sort((a, b) => {
						// The Den (home) is always pinned to the very top, above everything.
						if (a.thread_id === 'default') return -1;
						if (b.thread_id === 'default') return 1;
						return Number(b.pinned ?? false) - Number(a.pinned ?? false);
					}) as t (t.thread_id)}
					<div class="relative">
						{#if renamingFor === t.thread_id}
							<!-- Rename input replaces the row in-place. -->
							<form
								class="flex items-center gap-1 rounded-xl border border-purple-500/40 bg-zinc-900 px-2 py-1.5"
								onsubmit={(e) => {
									e.preventDefault();
									oncommitRename(t.thread_id);
								}}
							>
								<input
									type="text"
									bind:value={renameDraft}
									class="flex-1 bg-transparent text-xs text-white focus:outline-none"
									onkeydown={(e) => {
										if (e.key === 'Escape') oncancelRename();
									}}
								/>
								<button
									type="submit"
									class="rounded px-1.5 py-0.5 text-[10px] text-purple-300 hover:bg-purple-500/10"
									>Save</button
								>
								<button
									type="button"
									onclick={oncancelRename}
									class="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-800"
									>Cancel</button
								>
							</form>
						{:else}
							{@const isDen = t.thread_id === 'default'}
							<div
								class="group flex w-full items-center gap-1 rounded-xl pr-1
									{isDen
									? activeThread === t.thread_id
										? 'border border-brand/45 bg-brand/[0.12] shadow-[0_0_16px_-4px_rgba(236,45,120,0.4)]'
										: 'border border-brand/25 bg-brand/[0.07] hover:bg-brand/[0.14] hover:shadow-[0_0_12px_-4px_rgba(236,45,120,0.3)]'
									: activeThread === t.thread_id
										? 'border border-zinc-700/50 bg-zinc-800/40'
										: 'border border-transparent hover:border-white/[0.05] hover:bg-white/[0.04]'}
									{t.archived ? 'opacity-50' : ''}"
								style="transition: background 200ms cubic-bezier(0.22,0.61,0.36,1), border-color 200ms cubic-bezier(0.22,0.61,0.36,1), box-shadow 200ms cubic-bezier(0.22,0.61,0.36,1);"
							>
								<button
									type="button"
									onclick={() => onswitchThread(t.thread_id)}
									class="flex flex-1 items-center justify-between truncate px-3 py-2 text-left font-sans text-xs
										{isDen
										? 'font-semibold text-brand-soft'
										: activeThread === t.thread_id
											? 'font-medium text-white'
											: 'text-zinc-300'}"
								>
									<div class="flex min-w-0 items-center gap-2.5 truncate">
										{#if isDen}
											<Moon size={13} class="shrink-0 text-brand-soft" strokeWidth={2} />
										{:else}
											<Hash
												size={12}
												class="shrink-0 transition-colors {activeThread === t.thread_id
													? 'text-zinc-300'
													: 'text-zinc-600'}"
											/>
										{/if}
										<span class="truncate"
											>{t.thread_id === 'default' && t.title === 'default'
												? 'The Den'
												: t.title || t.thread_id}</span
										>
										{#if t.archived}
											<Archive size={10} class="shrink-0 text-zinc-600" />
										{/if}
									</div>
									{#if t.message_count > 0}
										<span
											class="ml-2 shrink-0 rounded border border-zinc-900 bg-zinc-950 px-1.5 py-0.5 font-sans text-[9px] text-zinc-500"
											>{t.message_count}</span
										>
									{/if}
								</button>
								<button
									type="button"
									data-popover-trigger
									onclick={(e) => {
										e.stopPropagation();
										threadMenuOpenFor = threadMenuOpenFor === t.thread_id ? null : t.thread_id;
									}}
									class="flex h-11 w-9 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white sm:h-7 sm:w-6"
									aria-label="Session options"
								>
									<MoreVertical size={13} />
								</button>
							</div>
						{/if}

						{#if threadMenuOpenFor === t.thread_id}
							<div
								data-popover
								class="absolute top-full right-0 z-50 mt-1 min-w-40 overflow-hidden rounded-xl border border-zinc-800 bg-[#0e0e0e] py-1 shadow-2xl"
							>
								<button
									type="button"
									onclick={() => ontogglePin(t)}
									class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-900"
								>
									<Pin size={11} class="text-zinc-500" />
									<span>{t.pinned ? 'Unpin' : 'Pin to top'}</span>
								</button>
								<button
									type="button"
									onclick={() => onopenRename(t)}
									class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-900 disabled:opacity-40"
								>
									<Edit3 size={11} class="text-zinc-500" />
									<span>Rename</span>
								</button>
								<button
									type="button"
									onclick={() => ontoggleArchive(t)}
									class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-900 disabled:opacity-40"
								>
									{#if t.archived}
										<ArchiveRestore size={11} class="text-zinc-500" />
										<span>Restore</span>
									{:else}
										<Archive size={11} class="text-zinc-500" />
										<span>Archive</span>
									{/if}
								</button>
								<button
									type="button"
									onclick={() => ondeleteThread(t)}
									class="flex w-full items-center gap-2 border-t border-zinc-800/50 px-3 py-1.5 text-left text-xs text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-40"
								>
									<Trash2 size={11} />
									<span>Delete</span>
								</button>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Sidebar Footer info -->
	<div
		class="shrink-0 space-y-0.5 border-t border-zinc-800/50 bg-black/25 p-3 font-sans text-[9px] text-zinc-600 select-none"
		style="padding-bottom: max(0.75rem, calc(env(safe-area-inset-bottom, 0px) + 0.5rem));"
	>
		<div>CORE: {coreLabel}</div>
		<div>HOST: 127.0.0.1:18080</div>
	</div>
</aside>
