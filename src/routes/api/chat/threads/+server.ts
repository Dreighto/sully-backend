import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listChatThreads } from '$lib/server/chat';
import {
	listThreadMeta,
	upsertThreadMeta,
	listRecentlyDeleted,
	purgeExpiredDeleted
} from '$lib/server/thread_meta';

export const GET: RequestHandler = async () => {
	try {
		// Lazy 90-day trash purge on access: hard-delete anything past the retention
		// window BEFORE reading the lists, so expired threads never surface. Guarded
		// so a purge hiccup can't take down the whole thread list.
		try {
			purgeExpiredDeleted();
		} catch (e) {
			console.error('purgeExpiredDeleted failed (non-fatal):', e);
		}

		// Raw message-based thread list (gives us message counts + latest ts).
		// listChatThreads already EXCLUDES soft-deleted threads (deleted_at set).
		// We used to force-insert a `default` thread when missing — that made
		// "delete default" feel broken (it'd reappear on next refresh). The
		// client now creates a fresh thread on demand instead, so the list
		// reflects reality.
		const rawThreads = listChatThreads();

		// Ensure every known thread has a meta row so the UI always has a title.
		for (const t of rawThreads) {
			upsertThreadMeta(t.thread_id, {});
			// Sync last_activity_at from chat_messages if the thread has messages.
			if (t.latest_ts) {
				upsertThreadMeta(t.thread_id, { last_activity_at: t.latest_ts });
			}
		}

		const { active, archived } = listThreadMeta();

		// Merge message counts + latest_ts into each meta entry.
		const rawMap = new Map(rawThreads.map((t) => [t.thread_id, t]));

		const enrich = (meta: ReturnType<typeof listThreadMeta>['active'][number]) => {
			const raw = rawMap.get(meta.thread_id);
			return {
				...meta,
				message_count: raw?.message_count ?? 0,
				latest_ts: raw?.latest_ts ?? meta.last_activity_at
			};
		};
		// Hide 0-message "ghost" threads. A meta row can exist with no persisted
		// message (a title minted before the first save, or messages later deleted),
		// and tapping one opens the empty landing greeting instead of a conversation.
		// The drawer should list only threads that actually have content.
		const hasMessages = (t: { message_count: number }) => t.message_count > 0;

		// active/archived explicitly drop soft-deleted rows (deleted_at set) so a
		// thread only ever lives in ONE of active / archived / recentlyDeleted.
		// recentlyDeleted is additive — existing clients read active/archived only.
		const notDeleted = (m: { deleted_at: string | null }) => !m.deleted_at;

		return json({
			active: active.filter(notDeleted).map(enrich).filter(hasMessages),
			archived: archived.filter(notDeleted).map(enrich).filter(hasMessages),
			recentlyDeleted: listRecentlyDeleted()
		});
	} catch (e: unknown) {
		console.error('GET /api/chat/threads error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
