// auto_title.ts — automatic thread naming.
//
// The /threads/:id/auto-title endpoint existed but NOTHING called it, so every
// thread stayed "New thread" (operator: "hard to pinpoint where threads live").
// This fire-and-forget helper runs after each assistant reply; it self-skips
// once a thread is titled, so it only does real work on the first exchange.

import { getChatMessages } from '$lib/server/chat';
import { getThreadMeta, setTitle } from '$lib/server/thread_meta';
import { routeChat } from '$lib/server/llm_router';

const DEFAULT_TITLE = 'New thread';

/**
 * Generate a 5-7 word title from the first user+assistant exchange if the thread
 * is still untitled. Fire-and-forget (`void maybeAutoTitle(id)`): never blocks
 * the reply stream, never throws, no-ops once titled or operator-renamed.
 */
export async function maybeAutoTitle(threadId: string | null | undefined): Promise<void> {
	try {
		if (!threadId) return;
		const meta = getThreadMeta(threadId);
		if (meta && meta.title !== DEFAULT_TITLE) return; // already titled / renamed

		const messages = getChatMessages(10, threadId);
		const firstUser = messages.find((m) => m.sender === 'operator');
		const firstAssistant = messages.find((m) => m.sender !== 'operator' && m.sender !== 'system');
		if (!firstUser || !firstAssistant) return; // need a full exchange first

		const prompt = `Generate a 5-7 word title for this conversation. Return ONLY the title, no quotes, no punctuation at the end.

User: ${firstUser.message.slice(0, 300)}
Assistant: ${firstAssistant.message.slice(0, 300)}`;

		const result = await routeChat('chat', [{ role: 'user', content: prompt }], 'gemini');
		const title = result.reply
			.trim()
			.replace(/^["'`]+|["'`.]+$/g, '')
			.slice(0, 80);
		if (title) setTitle(threadId, title);
	} catch (e) {
		console.error('maybeAutoTitle error:', e);
	}
}
