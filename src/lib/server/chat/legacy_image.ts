import { addChatMessage } from '$lib/server/chat';
import { generateGeminiImage } from '$lib/server/gemini';
import type { ChatPostContext } from '$lib/server/chat/legacy_context';

export async function handleImageGeneration(ctx: ChatPostContext): Promise<void> {
	try {
		const { url } = await generateGeminiImage(ctx.normalizedMessage.trim());
		const md = `![${ctx.normalizedMessage.trim().slice(0, 80) || 'generated image'}](${url})`;
		addChatMessage('agy', md, null, null, null, 'sent', ctx.threadId);
	} catch (err) {
		console.error('Gemini image gen failed:', err);
		const msg = err instanceof Error ? err.message : 'unknown error';
		// Only blame the key for genuine auth failures. The common case is
		// the model declining a prompt (copyrighted character, safety, etc.) -
		// show that real reason instead of a misleading "check your key".
		const isAuth = /not set in environment|HTTP 401|HTTP 403|API[_ ]?key/i.test(msg);
		const body = isAuth
			? `⚠️ **Image generation failed — API key problem.** \`${msg.slice(0, 300)}\``
			: `⚠️ **No image generated.** ${msg.slice(0, 400)}`;
		addChatMessage('system', body, null, null, null, 'sent', ctx.threadId);
	}
}
