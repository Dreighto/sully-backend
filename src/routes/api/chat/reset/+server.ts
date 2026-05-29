import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { addChatMessage } from '$lib/server/chat';

/**
 * Drop a "--- NEW CONVERSATION ---" system marker into the chat stream.
 * Subsequent worker dispatches see only messages AFTER this marker as
 * their context (see api/chat/+server.ts history slicing), so resets
 * actually clear worker memory.
 *
 * Body (optional): { reason?: string }
 */
export const POST: RequestHandler = async ({ request }) => {
	let reason = '';
	let threadId = 'default';
	try {
		const body = await request.json();
		reason = (body && typeof body.reason === 'string' ? body.reason : '').trim();
		threadId = (body && typeof body.thread === 'string' ? body.thread.trim() : '') || 'default';
	} catch {
		// no body is fine — reset with no annotation, default thread
	}

	const marker = reason
		? `--- NEW CONVERSATION --- (${reason.slice(0, 120)})`
		: '--- NEW CONVERSATION ---';
	const msg = addChatMessage('system', marker, null, null, null, 'sent', threadId);
	return json({ message: msg });
};
