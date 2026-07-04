import { addChatMessage } from '$lib/server/chat';
import { callHermes, chatRowsToHermesHistory } from '$lib/server/hermes';
import { getHistorySinceReset } from '$lib/server/chat/history';
import type { ChatPostContext } from '$lib/server/chat/legacy_context';

export async function handleHermes(ctx: ChatPostContext): Promise<void> {
	try {
		// Slice at the most recent NEW CONVERSATION marker, same as the
		// gateway-worker prompt builder. Hermes deserves the same fresh-
		// thread semantics.
		const { rows } = getHistorySinceReset(ctx.threadId, 30);
		// Exclude the operator message we JUST inserted (it's the
		// userMessage we pass separately to callHermes).
		const slice = rows.slice(0, -1);
		const history = chatRowsToHermesHistory(slice);
		const reply = await callHermes(history, ctx.normalizedMessage.trim());
		addChatMessage('hermes', reply, null, null, null, 'sent', ctx.threadId);
	} catch (err) {
		console.error('Hermes call failed:', err);
		const msg = err instanceof Error ? err.message : 'unknown error';
		addChatMessage(
			'system',
			`⚠️ **Hermes failed.** Local Ollama call errored: \`${msg.slice(0, 200)}\`. Check Ollama (\`ollama ps\`) and the qwen2.5:7b model.`,
			null,
			null,
			null,
			'sent',
			ctx.threadId
		);
	}
}
