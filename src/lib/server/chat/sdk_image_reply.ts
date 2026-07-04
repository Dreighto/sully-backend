import { createUIMessageStream, createUIMessageStreamResponse, generateId } from 'ai';
import { generateGeminiImage } from '$lib/server/gemini';
import { persistAssistantTurn } from '$lib/server/chat_turn';
import { markSelfHandled } from '$lib/server/dispatchJobs';
import { logTaskEvent } from '$lib/server/chatActivity';
import { maybeAutoTitle } from '$lib/server/auto_title';
import { finishWithReplyId, rollbackOrphanTurn } from '$lib/server/chat/sdk_stream_common';

// "generate an image of X" -> the direct Gemini image model, NOT a coding-worker
// dispatch. Requires a generation verb AND an image noun close together so it
// doesn't fire on "I have an image problem in my code".
const IMAGE_INTENT_RE =
	/\b(generate|create|make|draw|render|paint|design|sketch|illustrate|whip up|cook up)\b[\s\S]{0,30}\b(image|picture|photo|pic|illustration|drawing|artwork|logo|icon|portrait|wallpaper|painting)\b/i;

export function isImageRequest(text: string): boolean {
	return IMAGE_INTENT_RE.test(text);
}

// Strip a worker-routing prefix ("@agy ", "dispatch agy to ") so it doesn't
// pollute the image prompt; keep the actual description.
export function imagePromptFrom(text: string): string {
	return text
		.replace(/^\s*@\w+[\s,:]+/i, '')
		.replace(/^\s*dispatch\s+\w+\s+to\s+/i, '')
		.replace(/^\s*(please|hey|can you|could you)\b[\s,]*/i, '')
		.trim();
}

export function generateImageReply(opts: {
	prompt: string;
	threadId: string;
	taskId: string;
	operatorRowId: number;
	reused: boolean;
}): Response {
	const { prompt, threadId, taskId, operatorRowId, reused } = opts;
	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			const messageId = generateId();
			const textId = '0';
			writer.write({ type: 'start', messageId });
			let md: string;
			try {
				const { url } = await generateGeminiImage(prompt);
				const altText = prompt
					.slice(0, 80)
					.replace(/[\[\]\r\n]/g, ' ')
					.trim();
				md = `![${altText}](${url})`;
			} catch (e) {
				const msg = e instanceof Error ? e.message : 'unknown error';
				rollbackOrphanTurn(operatorRowId, taskId, reused);
				writer.write({
					type: 'error',
					errorText: `Image generation failed (gemini-2.5-flash-image): ${msg.slice(0, 300)}`
				});
				writer.write({ type: 'finish', finishReason: 'error' });
				return;
			}
			const replyId = persistAssistantTurn({
				text: md,
				sender: 'agy',
				threadId,
				model: 'gemini-2.5-flash-image',
				tier: 'chat',
				taskId,
				provider: 'gemini',
				reused
			});
			markSelfHandled(taskId);
			logTaskEvent(taskId, 'gate_evaluated', {
				action: 'Talk',
				reason: 'image-generation',
				dispatched: false
			});
			void maybeAutoTitle(threadId);
			writer.write({ type: 'start-step' });
			writer.write({ type: 'text-start', id: textId });
			writer.write({ type: 'text-delta', id: textId, delta: md });
			writer.write({ type: 'text-end', id: textId });
			writer.write({ type: 'finish-step' });
			finishWithReplyId(writer, replyId, 'stop');
		}
	});
	return createUIMessageStreamResponse({ stream });
}
