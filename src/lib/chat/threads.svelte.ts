import { tick } from 'svelte';
import { resolve } from '$app/paths';
import type { ChatMessage } from '$lib/types/chat-ui';
import { toasts } from '$lib/utils/toasts';

export type ThreadSummary = {
	thread_id: string;
	title: string;
	archived: boolean;
	pinned: boolean;
	message_count: number;
	latest_ts?: string;
};

export interface ThreadsDeps {
	getInitialThreads: () => ThreadSummary[];
	getInitialActiveThread: () => string;
	setMessages: (messages: ChatMessage[]) => void;
	setSidebarOpen: (open: boolean) => void;
	pollMessages: (threadId: string) => Promise<void>;
	loadTier: (threadId: string) => Promise<void>;
	syncUrlThread: (threadId: string) => void;
}

export interface ThreadsController {
	threads: ThreadSummary[];
	activeThread: string;
	renamingFor: string | null;
	renameDraft: string;
	showArchived: boolean;
	threadMenuOpenFor: string | null;
	switchThread: (threadId: string, opts?: { keepSidebarOpen?: boolean }) => Promise<void>;
	slugifyThreadName: (name: string) => string;
	findUniqueSlug: (baseSlug: string) => Promise<string>;
	newThread: () => Promise<void>;
	openRename: (thread: { thread_id: string; title: string }) => void;
	commitRename: (threadId: string) => Promise<void>;
	cancelRename: () => void;
	toggleArchive: (thread: { thread_id: string; archived: boolean }) => Promise<void>;
	togglePin: (thread: { thread_id: string; pinned: boolean }) => Promise<void>;
	deleteThreadById: (thread: { thread_id: string; archived: boolean }) => Promise<void>;
	clearAllSessions: () => Promise<void>;
	maybeAutoTitleAfterReply: (threadId: string) => Promise<void>;
	destroy: () => void;
}

export function createThreadsController(deps: ThreadsDeps): ThreadsController {
	let threads = $state<ThreadSummary[]>(deps.getInitialThreads());
	let activeThread = $state(deps.getInitialActiveThread());
	let renamingFor = $state<string | null>(null);
	let renameDraft = $state('');
	let showArchived = $state(false);
	let threadMenuOpenFor = $state<string | null>(null);

	async function switchThread(threadId: string, opts: { keepSidebarOpen?: boolean } = {}) {
		if (threadId === activeThread) {
			if (!opts.keepSidebarOpen) deps.setSidebarOpen(false);
			return;
		}
		activeThread = threadId;
		// keepSidebarOpen lets newThread() keep the panel visible long enough
		// for the operator to see the new row appear (otherwise the sidebar
		// slid shut in the same tick — operator had to re-open to see the
		// thread they just created).
		if (!opts.keepSidebarOpen) deps.setSidebarOpen(false);
		deps.setMessages([]);
		// Pass the target thread explicitly so pollMessages can drop the
		// response if another switch happens before this fetch returns.
		await deps.pollMessages(threadId);
		await deps.loadTier(threadId);
		deps.syncUrlThread(threadId);
	}

	function slugifyThreadName(name: string): string {
		return (
			name
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9-]+/g, '-')
				.replace(/^-+|-+$/g, '')
				.slice(0, 40) || 'thread'
		);
	}

	async function findUniqueSlug(baseSlug: string): Promise<string> {
		const localUsed = new Set(threads.map((t) => t.thread_id));
		let slug = baseSlug;
		let i = 1;
		while (i < 200) {
			if (!localUsed.has(slug)) {
				// Probe the DB; orphan rows can survive a failed delete.
				try {
					const r = await fetch(
						resolve('/api/chat') + `?thread=${encodeURIComponent(slug)}&limit=1`
					);
					if (r.ok) {
						const b = await r.json();
						if (!Array.isArray(b.messages) || b.messages.length === 0) return slug;
					} else {
						return slug;
					}
				} catch {
					return slug;
				}
			}
			i++;
			slug = `${baseSlug}-${i}`;
		}
		return `${baseSlug}-${Date.now()}`;
	}

	async function newThread() {
		const stamp = Date.now().toString(36).slice(-5);
		const baseSlug = `chat-${stamp}`;
		const slug = await findUniqueSlug(baseSlug);
		const title = 'New thread';
		threads = [
			{
				thread_id: slug,
				title,
				archived: false,
				pinned: false,
				message_count: 0,
				latest_ts: ''
			},
			...threads
		];
		// Yield a microtask so the {#each} in ThreadsSidebar materializes the
		// new row's DOM node BEFORE switchThread runs the auto-scroll $effect
		// keyed on activeThread. Without this, the scroll-into-view lookup
		// races and the new entry doesn't visibly land at the top of the list.
		await tick();
		// keepSidebarOpen so the operator sees the row appear, instead of the
		// panel sliding shut in the same tick the row was inserted.
		void switchThread(slug, { keepSidebarOpen: true });
	}

	function openRename(t: { thread_id: string; title: string }) {
		threadMenuOpenFor = null;
		renamingFor = t.thread_id;
		renameDraft = t.title || t.thread_id;
	}

	async function commitRename(threadId: string) {
		const title = renameDraft.trim();
		renamingFor = null;
		if (!title) return;
		threads = threads.map((t) => (t.thread_id === threadId ? { ...t, title } : t));
		try {
			await fetch(resolve(`/api/chat/threads/${encodeURIComponent(threadId)}`), {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title })
			});
		} catch {
			toasts.add('Rename failed - try again', 'error');
		}
	}

	function cancelRename() {
		renamingFor = null;
		renameDraft = '';
	}

	async function toggleArchive(t: { thread_id: string; archived: boolean }) {
		threadMenuOpenFor = null;
		const archived = !t.archived;
		threads = threads.map((x) => (x.thread_id === t.thread_id ? { ...x, archived } : x));
		try {
			await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ archived })
			});
			toasts.add(archived ? `Archived "${t.thread_id}"` : `Restored "${t.thread_id}"`, 'success');
		} catch {
			toasts.add('Archive failed', 'error');
		}
	}

	async function togglePin(t: { thread_id: string; pinned: boolean }) {
		threadMenuOpenFor = null;
		const pinned = !t.pinned;
		threads = threads.map((x) => (x.thread_id === t.thread_id ? { ...x, pinned } : x));
		try {
			await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pinned })
			});
			toasts.add(pinned ? `Pinned "${t.thread_id}"` : `Unpinned "${t.thread_id}"`, 'success');
		} catch {
			toasts.add('Pin update failed', 'error');
		}
	}

	async function deleteThreadById(t: { thread_id: string; archived: boolean }) {
		threadMenuOpenFor = null;
		if (!t.archived) {
			await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ archived: true })
			}).catch(() => null);
		}
		const ok = window.confirm(
			`Delete thread "${t.thread_id}"? This permanently removes all messages, drafts, and metadata for it.`
		);
		if (!ok) return;
		try {
			const r = await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
				method: 'DELETE'
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			threads = threads.filter((x) => x.thread_id !== t.thread_id);
			if (activeThread === t.thread_id) {
				const next = threads[0]?.thread_id;
				if (next) await switchThread(next);
				else await newThread();
			}
			toasts.add(`Deleted "${t.thread_id}"`, 'success');
		} catch (e) {
			toasts.add(`Delete failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error');
		}
	}

	async function maybeAutoTitleAfterReply(threadId: string): Promise<void> {
		// Never auto-title 'default' (The Den) — it's the hardcoded home thread.
		if (!threadId || threadId === 'default') return;
		const t = threads.find((x) => x.thread_id === threadId);
		if (!t) return;
		// Client-local newThread sets title='New thread'. After an SSR reload, an
		// untitled thread's displayTitle falls back to the slug (== thread_id).
		// Either case = "looks default, safe to attempt auto-title". The server
		// endpoint re-checks meta.title === 'New thread' as the authoritative gate.
		if (t.title !== 'New thread' && t.title !== t.thread_id) return;
		try {
			const r = await fetch(
				resolve(`/api/chat/threads/${encodeURIComponent(threadId)}/auto-title`),
				{ method: 'POST' }
			);
			if (!r.ok) return;
			const body = (await r.json()) as { title?: string; skipped?: boolean };
			if (body.skipped || !body.title) return;
			// Patch the local row in place so the sidebar re-renders without a
			// full GET refetch (which would also re-render every other row).
			threads = threads.map((x) =>
				x.thread_id === threadId ? { ...x, title: body.title as string } : x
			);
		} catch {
			/* silent — sidebar auto-title is best-effort, never blocks the UI */
		}
	}

	async function clearAllSessions() {
		const ok = window.confirm(
			'Archive and delete every thread? This cannot be undone. A fresh thread will be created after.'
		);
		if (!ok) return;
		let removed = 0;
		for (const t of threads) {
			try {
				await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ archived: true })
				});
				const r = await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
					method: 'DELETE'
				});
				if (r.ok) removed++;
			} catch {
				/* skip */
			}
		}
		threads = [];
		toasts.add(`Cleared ${removed} thread${removed === 1 ? '' : 's'}`, 'success');
		await newThread();
	}

	return {
		get threads() {
			return threads;
		},
		set threads(value) {
			threads = value;
		},
		get activeThread() {
			return activeThread;
		},
		set activeThread(value) {
			activeThread = value;
		},
		get renamingFor() {
			return renamingFor;
		},
		set renamingFor(value) {
			renamingFor = value;
		},
		get renameDraft() {
			return renameDraft;
		},
		set renameDraft(value) {
			renameDraft = value;
		},
		get showArchived() {
			return showArchived;
		},
		set showArchived(value) {
			showArchived = value;
		},
		get threadMenuOpenFor() {
			return threadMenuOpenFor;
		},
		set threadMenuOpenFor(value) {
			threadMenuOpenFor = value;
		},
		switchThread,
		slugifyThreadName,
		findUniqueSlug,
		newThread,
		openRename,
		commitRename,
		cancelRename,
		toggleArchive,
		togglePin,
		deleteThreadById,
		clearAllSessions,
		maybeAutoTitleAfterReply,
		destroy: () => {}
	};
}
