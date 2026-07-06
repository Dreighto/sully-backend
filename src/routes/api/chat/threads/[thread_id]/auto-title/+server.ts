import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getChatMessages } from '$lib/server/chat';
import { getThreadMeta, setTitle } from '$lib/server/thread_meta';
import { routeChat } from '$lib/server/llm_router';

/**
 * POST /api/chat/threads/[thread_id]/auto-title
 * Fires after the first assistant reply on a new thread. Generates a 5-7 word
 * title from the first user + first assistant exchange via Flash-lite (chat tier).
 * No-ops if the thread already has a non-default title.
 */
export const POST: RequestHandler = async ({ params }) => {
	const { thread_id } = params;
	if (!thread_id) return json({ error: 'missing thread_id' }, { status: 400 });

	try {
		const meta = getThreadMeta(thread_id);
		// Skip if already titled (don't overwrite operator-renamed threads).
		if (meta && meta.title !== 'New thread') {
			return json({ skipped: true, title: meta.title });
		}

		const messages = getChatMessages(10, thread_id);
		const firstUser = messages.find((m) => m.sender === 'operator');
		const firstAssistant = messages.find((m) => m.sender !== 'operator' && m.sender !== 'system');

		if (!firstUser || !firstAssistant) {
			return json({ skipped: true, reason: 'not_enough_messages' });
		}

		const prompt = `Generate a 5-7 word title for this conversation. Return ONLY the title, no quotes, no punctuation at the end.

User: ${firstUser.message.slice(0, 300)}
Assistant: ${firstAssistant.message.slice(0, 300)}`;

		const result = await routeChat('chat', [{ role: 'user', content: prompt }], 'gemini');
		const title = result.reply.trim().slice(0, 80) || 'New thread';

		setTitle(thread_id, title);

		return json({ title });
	} catch (e) {
		console.error('POST /api/chat/threads/:id/auto-title error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
