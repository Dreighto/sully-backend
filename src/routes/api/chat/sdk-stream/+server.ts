// SDK-native streaming endpoint. The route owns request parsing, validation,
// shared turn preparation, and branch selection; branch behavior lives in
// $lib/server/chat/sdk_*_reply.ts.

import type { RequestHandler } from './$types';
import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	generateId,
	type UIMessage
} from 'ai';
import { getSensitiveTools } from '$lib/server/companion_tools';
import { baseTools } from '$lib/server/chat/base_tools';
import { prepareStream, type Provider } from '$lib/server/chat/stream_prepare';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import { needsFullReply } from '$lib/server/routing/turn_decision';
import { rollbackOrphanTurn } from '$lib/server/chat/sdk_stream_common';
import {
	generateImageReply,
	imagePromptFrom,
	isImageRequest
} from '$lib/server/chat/sdk_image_reply';
import { handleCliReply } from '$lib/server/chat/sdk_cli_reply';
import { handleLocalReply } from '$lib/server/chat/sdk_local_reply';
import { handleDirectReply, resolveDirectModel } from '$lib/server/chat/sdk_direct_reply';

function latestUserText(messages: UIMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== 'user') continue;
		const parts = m.parts || [];
		const txt = parts
			.filter((p) => p.type === 'text')
			.map((p) => (p as { type: 'text'; text: string }).text)
			.join('');
		if (txt) return txt;
	}
	return '';
}

export const POST: RequestHandler = async ({ request }) => {
	let body: {
		messages?: UIMessage[];
		thread?: string;
		target_repo?: string;
		provider?: Provider;
		model?: string;
		client_turn_id?: string;
	};
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'invalid_json' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const messages = body.messages ?? [];
	if (!Array.isArray(messages) || messages.length === 0) {
		return new Response(JSON.stringify({ error: 'messages_required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const threadId =
		typeof body.thread === 'string' && body.thread.trim() ? body.thread.trim() : 'default';
	const userText = latestUserText(messages);
	if (!userText) {
		return new Response(JSON.stringify({ error: 'no_text_content' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const clientTurnId =
		typeof body.client_turn_id === 'string' && body.client_turn_id.trim()
			? body.client_turn_id.trim()
			: null;

	const ctx = await prepareStream({
		messages,
		threadId,
		userText,
		provider: body.provider,
		model: body.model,
		targetRepoHint: body.target_repo,
		headers: request.headers,
		clientTurnId
	});

	if (isImageRequest(ctx.userText)) {
		return generateImageReply({
			prompt: imagePromptFrom(ctx.userText),
			threadId,
			taskId: ctx.taskId,
			operatorRowId: ctx.operatorRowId,
			reused: ctx.reused
		});
	}

	const decision = ctx.shadowDecision;
	if (!needsFullReply(decision)) {
		await applyTurnDecision(decision, {
			taskId: ctx.taskId,
			threadId,
			targetRepo: ctx.targetRepo,
			userText: ctx.userText,
			reused: ctx.reused
		});
		const stream = createUIMessageStream({
			execute: ({ writer }) => {
				const messageId = generateId();
				writer.write({ type: 'start', messageId });
				writer.write({ type: 'finish', finishReason: 'stop' });
			}
		});
		return createUIMessageStreamResponse({ stream });
	}

	if (ctx.useClaudeCLI) return handleCliReply(ctx, request);

	let modelHandle: ReturnType<typeof resolveDirectModel>;
	try {
		modelHandle = resolveDirectModel({ ctx, requestedModel: body.model });
	} catch (err) {
		rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
		return new Response(
			JSON.stringify({ error: 'credential_unavailable', detail: (err as Error).message }),
			{ status: 503, headers: { 'Content-Type': 'application/json' } }
		);
	}

	const tools = ctx.allowSensitive ? { ...baseTools, ...getSensitiveTools() } : baseTools;
	if (ctx.provider === 'local') {
		return handleLocalReply({ ctx, request, model: modelHandle.model, tools });
	}
	return handleDirectReply({ ctx, request, modelHandle, tools });
};
