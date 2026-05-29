import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setActiveThread, getActiveThread } from '$lib/server/chat';

/**
 * GET /api/chat/state — return the current persisted operator state
 * (active thread). Mostly used by clients that want to verify or refresh.
 */
export const GET: RequestHandler = async () => {
	return json({ active_thread: getActiveThread() });
};

/**
 * POST /api/chat/state — persist a new active thread. Body: { thread }.
 * Called by the chat tab when the operator picks a thread from the
 * switcher dropdown.
 */
export const POST: RequestHandler = async ({ request }) => {
	let thread = '';
	try {
		const body = await request.json();
		thread = (body && typeof body.thread === 'string' ? body.thread.trim() : '') || '';
	} catch {
		return json({ error: 'invalid body' }, { status: 400 });
	}
	if (!thread) return json({ error: 'thread required' }, { status: 400 });
	setActiveThread(thread);
	return json({ ok: true, active_thread: thread });
};
