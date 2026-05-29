import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getChatMessages } from '$lib/server/chat';
import { setSummary } from '$lib/server/thread_meta';
import { routeChat } from '$lib/server/llm_router';

/**
 * POST /api/chat/threads/[thread_id]/summary
 * Generates a 2-3 sentence summary of the thread via Flash-lite (chat tier)
 * and persists it to chat_thread_meta.summary.
 */
export const POST: RequestHandler = async ({ params }) => {
	const { thread_id } = params;
	if (!thread_id) return json({ error: 'missing thread_id' }, { status: 400 });

	try {
		const messages = getChatMessages(200, thread_id);
		if (messages.length === 0) {
			return json({ error: 'no_messages' }, { status: 422 });
		}

		// Build a condensed transcript (operator + worker turns only).
		const transcript = messages
			.filter((m) => m.sender !== 'system')
			.slice(-40)
			.map((m) => `${m.sender === 'operator' ? 'Operator' : 'Assistant'}: ${m.message}`)
			.join('\n');

		const result = await routeChat(
			'chat',
			[
				{
					role: 'user',
					content: `Summarize this conversation in 2-3 sentences. Be concrete — name the main topics discussed and any decisions or outcomes reached. Do not editorialize.\n\n${transcript}`
				}
			],
			'gemini'
		);

		setSummary(thread_id, result.reply.trim());

		return json({ summary: result.reply.trim() });
	} catch (e) {
		console.error('POST /api/chat/threads/:id/summary error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
