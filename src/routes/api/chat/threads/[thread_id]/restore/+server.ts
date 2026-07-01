import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { restoreThread } from '$lib/server/thread_meta';

/**
 * POST /api/chat/threads/[thread_id]/restore
 *
 * Restore a soft-deleted thread out of Recently Deleted: clears deleted_at so the
 * thread returns to the active list. Idempotent — restoring an already-active
 * thread is a harmless no-op that still returns {ok:true}.
 */
export const POST: RequestHandler = async ({ params }) => {
	const { thread_id } = params;
	if (!thread_id) return json({ error: 'missing thread_id' }, { status: 400 });

	const result = restoreThread(thread_id);
	if (!result.ok) {
		return json({ error: 'internal_server_error' }, { status: 500 });
	}

	return json({ ok: true });
};
