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
		Plus,
		Pin,
		MessageSquare,
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
		onclearAll
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
	class="fixed top-0 bottom-0 left-0 z-[60] flex w-72 flex-col border-r border-zinc-800/60 bg-[#090909]/98 shadow-2xl backdrop-blur-2xl transition-all duration-300 ease-in-out lg:static lg:z-auto lg:translate-x-0
		{sidebarOpen
		? 'translate-x-0 lg:w-72 lg:opacity-100'
		: '-translate-x-full lg:pointer-events-none lg:w-0 lg:opacity-0'}"
>
	<!-- Sidebar Header -->
	<div class="flex shrink-0 items-center justify-between border-b border-zinc-800/50 px-4 py-4">
		<div class="flex items-center gap-2">
			<img src="{base}/favicon.png" alt="LogueOS" class="h-6 w-6" />
			<span class="font-mono text-xs font-semibold tracking-wider text-zinc-300 uppercase"
				>Sessions</span
			>
		</div>
		<div class="flex items-center gap-1.5">
			<button
				type="button"
				onclick={onnewThread}
				class="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 transition-all hover:scale-105 hover:text-white active:scale-95 sm:h-7 sm:w-7"
				title="Create new session"
				aria-label="New thread"
			>
				<Plus size={14} />
			</button>
			<button
				type="button"
				onclick={oncloseSidebar}
				class="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 transition-all hover:text-white sm:h-7 sm:w-7 lg:hidden"
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
				class="flex items-center gap-1 font-mono text-[9px] tracking-wider text-zinc-500 uppercase transition-colors hover:text-zinc-300"
				title={showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
			>
				<Archive size={10} />
				<span>{showArchived ? 'Hide archived' : 'Show archived'}</span>
			</button>
			<button
				type="button"
				onclick={onclearAll}
				class="flex items-center gap-1 rounded font-mono text-[9px] tracking-wider text-zinc-600 uppercase transition-colors hover:text-red-400"
				title="Archive and delete every thread"
			>
				<Eraser size={10} />
				<span>Clear all</span>
			</button>
		</div>

		{#if threads.length === 0}
			<div class="px-3 py-4 text-center font-mono text-[10px] text-zinc-600">No sessions yet</div>
		{:else}
			<div class="space-y-1">
				{#each threads
					.filter((t) => showArchived || !t.archived)
					.slice()
					.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false)) as t (t.thread_id)}
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
									autofocus
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
							<div
								class="group flex w-full items-center gap-1 rounded-xl pr-1 transition-all
									{activeThread === t.thread_id
									? 'border border-zinc-700/50 bg-zinc-800/40'
									: 'border border-transparent hover:bg-zinc-900/40'}
									{t.archived ? 'opacity-60' : ''}"
							>
								<button
									type="button"
									onclick={() => onswitchThread(t.thread_id)}
									class="flex flex-1 items-center justify-between truncate px-3 py-2 text-left font-sans text-xs
										{activeThread === t.thread_id ? 'font-medium text-white' : 'text-zinc-300'}"
								>
									<div class="flex min-w-0 items-center gap-2.5 truncate">
										<MessageSquare
											size={13}
											class={activeThread === t.thread_id ? 'text-purple-400' : 'text-zinc-500'}
										/>
										<span class="truncate"
											>{t.thread_id === 'default' && t.title === 'default'
												? 'Default Space'
												: t.title || t.thread_id}</span
										>
										{#if t.archived}
											<Archive size={10} class="shrink-0 text-zinc-600" />
										{/if}
									</div>
									{#if t.message_count > 0}
										<span
											class="ml-2 shrink-0 rounded border border-zinc-900 bg-zinc-950 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500"
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
		class="shrink-0 space-y-0.5 border-t border-zinc-800/50 bg-black/25 p-3 font-mono text-[9px] text-zinc-600 select-none"
	>
		<div>CORE: LogueOS-Console</div>
		<div>HOST: 127.0.0.1:18080</div>
	</div>
</aside>
