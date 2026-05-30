// Chat Surface V2 AGY — server load. Reuses the same data shape as /chat.
// Visual rewrite only; backend contracts unchanged.

import type { PageServerLoad } from './$types';
import { getChatMessages, listChatThreads, getActiveThread } from '$lib/server/chat';
import { listThreadMeta } from '$lib/server/thread_meta';
import { serverConfig, runMode, clientSafeConfig, appIdentity } from '$lib/server/config';

export type Workspace = {
	name: string;
	display_name: string;
	group: string;
	emoji: string;
	default_branch: string;
	pool_size: number;
	is_archived: boolean;
};

const WIRED_FALLBACK_WORKSPACES: Workspace[] = [
	{
		name: 'LogueOS-Console',
		display_name: 'Console',
		group: 'LogueOS Kernel',
		emoji: '💻',
		default_branch: 'main',
		pool_size: 1,
		is_archived: false
	},
	{
		name: 'LogueOS-Orchestrator',
		display_name: 'Orchestrator',
		group: 'LogueOS Kernel',
		emoji: '⚙️',
		default_branch: 'main',
		pool_size: 1,
		is_archived: false
	},
	{
		name: 'project-miru',
		display_name: 'Miru',
		group: 'Miru Cluster',
		emoji: '👁️',
		default_branch: 'main',
		pool_size: 4,
		is_archived: false
	},
	{
		name: 'NASDOOM',
		display_name: 'NASDOOM',
		group: 'Side Projects',
		emoji: '🎮',
		default_branch: 'main',
		pool_size: 3,
		is_archived: false
	}
];

// Companion mode is a standalone local app — the kernel workspace list is
// vestigial here. Surface a single fork-aware entry so the repo chip doesn't
// hand the user "LogueOS-Console" as option 1 in companion mode.
const COMPANION_FALLBACK_WORKSPACES: Workspace[] = [
	{
		name: appIdentity.defaultWorkspace,
		display_name: 'Companion',
		group: 'Local',
		emoji: '🦉',
		default_branch: 'main',
		pool_size: 1,
		is_archived: false
	}
];

const FALLBACK_WORKSPACES: Workspace[] = runMode.companion
	? COMPANION_FALLBACK_WORKSPACES
	: WIRED_FALLBACK_WORKSPACES;

export const load: PageServerLoad = async ({ url }) => {
	const queryThread = url.searchParams.get('thread');
	const thread = (queryThread || getActiveThread() || 'default').trim() || 'default';
	const messages = getChatMessages(100, thread);

	// Merge two sources: chat_messages-derived list (for backfill of threads
	// that predate the meta table) + chat_thread_meta (for title / archived /
	// pinned). Threads in meta but without messages still surface so empty
	// renamed threads don't disappear; threads in messages but without meta
	// get a default title of their thread_id.
	const messageThreads = listChatThreads();
	const meta = listThreadMeta();
	const metaById = new Map([...meta.active, ...meta.archived].map((m) => [m.thread_id, m]));

	type ThreadRow = {
		thread_id: string;
		title: string;
		archived: boolean;
		pinned: boolean;
		message_count: number;
		latest_ts: string;
	};
	const seen = new Set<string>();
	const rows: ThreadRow[] = [];

	// Title fallback: the meta table defaults title to 'New thread' on
	// auto-backfill. That string is a placeholder — until the operator
	// explicitly renames, we surface the thread_id which is at least
	// recognizable instead of a wall of "New thread" rows.
	const displayTitle = (metaTitle: string | undefined, thread_id: string): string => {
		if (!metaTitle || metaTitle === 'New thread') return thread_id;
		return metaTitle;
	};

	for (const t of messageThreads) {
		const m = metaById.get(t.thread_id);
		rows.push({
			thread_id: t.thread_id,
			title: displayTitle(m?.title, t.thread_id),
			archived: m?.archived ?? false,
			pinned: m?.pinned ?? false,
			message_count: t.message_count,
			latest_ts: t.latest_ts
		});
		seen.add(t.thread_id);
	}
	// Meta-only threads (renamed empty threads, etc.)
	for (const m of [...meta.active, ...meta.archived]) {
		if (seen.has(m.thread_id)) continue;
		rows.push({
			thread_id: m.thread_id,
			title: displayTitle(m.title, m.thread_id),
			archived: m.archived,
			pinned: m.pinned,
			message_count: 0,
			latest_ts: m.last_activity_at
		});
	}
	// (Removed: forced 'default' thread insert. Operator directive 2026-05-27 —
	// the list should reflect reality so "delete default" doesn't feel broken.
	// If the operator deletes everything, sending creates a fresh thread on
	// the fly via newThread() on the client.)
	const threads = rows;

	let allWorkspaces: Workspace[] = FALLBACK_WORKSPACES;
	// Companion mode: the workspace list comes from the kernel gateway (off here).
	// Skip the fetch entirely to avoid a 3s timeout on every page load — the
	// FALLBACK list is the right answer when the kernel isn't running.
	if (runMode.gatewayWorkspaces) {
		try {
			const resp = await fetch(`${serverConfig.gatewayUrl}/api/v1/workspaces`, {
				signal: AbortSignal.timeout(3000)
			});
			if (resp.ok) {
				const body = (await resp.json()) as { workspaces?: unknown[] };
				if (Array.isArray(body.workspaces)) {
					allWorkspaces = body.workspaces as Workspace[];
				}
			}
		} catch {
			/* fall back silently */
		}
	}

	const workspaces = allWorkspaces.filter((w) => !w.is_archived);

	return {
		messages,
		threads,
		activeThread: thread,
		workspaces,
		appIdentity: clientSafeConfig.appIdentity
	};
};
