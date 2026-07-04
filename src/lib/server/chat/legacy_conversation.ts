import { addChatMessage } from '$lib/server/chat';
import { upsertThreadTier } from '$lib/server/thread_state';
import { routeChat } from '$lib/server/llm_router';
import type { RouterMessage } from '$lib/server/llm_router';
import { buildMultimodalContent } from '$lib/server/multimodal';
import { buildSystemPrompt } from '$lib/server/chat_prompt';
import { getHistorySinceReset } from '$lib/server/chat/history';
import type { ChatPostContext } from '$lib/server/chat/legacy_context';

export interface ConversationalChatResult {
	routerMeta: { provider_used: string; model_used: string } | null;
}

export async function handleConversationalChat(
	ctx: ChatPostContext
): Promise<ConversationalChatResult> {
	let routerMeta: { provider_used: string; model_used: string } | null = null;
	try {
		const { rows } = getHistorySinceReset(ctx.threadId, 30);
		const slice = rows.slice(0, -1);
		const routerMessages: RouterMessage[] = slice
			.filter((r) => r.sender !== 'system')
			.map((r) => ({
				role: (r.sender === 'operator' ? 'user' : 'assistant') as 'user' | 'assistant',
				content: r.message
			}));
		const lastContent = await buildMultimodalContent(ctx.normalizedMessage.trim());
		routerMessages.push({ role: 'user', content: lastContent });

		if (routerMessages.length > 20) {
			routerMessages.splice(0, routerMessages.length - 20);
		}

		const result = await routeChat(
			ctx.isTalkback ? 'chat' : ctx.currentTier,
			routerMessages,
			'gemini',
			undefined,
			await buildSystemPrompt(
				{ targetRepo: ctx.targetRepo, currentTier: ctx.currentTier, threadId: ctx.threadId },
				ctx.normalizedMessage.trim()
			)
		);
		addChatMessage('agy', result.reply, null, null, null, 'sent', ctx.threadId);
		upsertThreadTier(ctx.threadId, ctx.currentTier, result.model_used);
		routerMeta = { provider_used: result.provider_used, model_used: result.model_used };

		if (result.fell_forward) {
			addChatMessage(
				'system',
				`ℹ️ Primary provider unavailable — reply served by **${result.provider_used}** (${result.model_used}).`,
				null,
				null,
				null,
				'sent',
				ctx.threadId
			);
		}
	} catch (err) {
		console.error('LLM router chat call failed:', err);
		const msg = err instanceof Error ? err.message : 'unknown error';
		addChatMessage(
			'system',
			`⚠️ **LLM router failed.** \`${msg.slice(0, 200)}\`. Check provider keys and daily caps.`,
			null,
			null,
			null,
			'sent',
			ctx.threadId
		);
	}
	return { routerMeta };
}
