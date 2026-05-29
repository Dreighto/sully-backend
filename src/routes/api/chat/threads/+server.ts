import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listChatThreads } from '$lib/server/chat';
import { listThreadMeta, upsertThreadMeta } from '$lib/server/thread_meta';

export const GET: RequestHandler = async () => {
	try {
		// Raw message-based thread list (gives us message counts + latest ts).
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

		return json({ active: active.map(enrich), archived: archived.map(enrich) });
	} catch (e: unknown) {
		console.error('GET /api/chat/threads error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
