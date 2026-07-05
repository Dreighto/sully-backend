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
import { rollbackOrphanTurn, type SullyRoutingFrame } from '$lib/server/chat/sdk_stream_common';
import { resolveAutoFallback, routingFrameForExplicitPick } from '$lib/server/chat/auto_router';
import {
	generateImageReply,
	imagePromptFrom,
	isImageRequest
} from '$lib/server/chat/sdk_image_reply';
import { handleCliReply } from '$lib/server/chat/sdk_cli_reply';
import { handleLocalReply } from '$lib/server/chat/sdk_local_reply';
import {
	handleDirectReply,
	isAnthropicCapExceeded,
	pickFallbackModel,
	resolveDirectModel,
	sullyErrorFrame
} from '$lib/server/chat/sdk_direct_reply';
import { handleAutoReply } from '$lib/server/chat/sdk_auto_reply';
import { classifyShadow, logEscalation, shadowObserve } from '$lib/server/brains/shadow_router';

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

	// Hybrid brain Phase 2 → Phase 4: classify the turn and log it. The
	// verdict is now used to influence routing (LOCAL → local model,
	// ESCALATE → Claude). Phase 5 sends ESCALATE decisions to the training
	// corpus telemetry so the local model can learn from specialist
	// interventions.
	const hybridVerdict = classifyShadow(userText);
	shadowObserve(threadId, userText, 'sdk-stream');

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

	if (ctx.autoMode) {
		return handleAutoReply(ctx);
	}

	if (ctx.useClaudeCLI) {
		const routing = routingFrameForExplicitPick({ ctx, modelId: ctx.resolvedModelId });
		return handleCliReply(ctx, request, { routing });
	}

	let modelHandle: ReturnType<typeof resolveDirectModel> | undefined;
	let routing: SullyRoutingFrame | undefined;
	let fallbackReason: string | undefined;

	// Phase 4: hybrid brain routing — when the shadow router classifies a
	// message as LOCAL and the operator hasn't pinned an explicit provider,
	// route to the local model (qwen3:14b on Ollama). ESCALATE keeps the
	// anthropic path. unsure defaults to the usual provider (anthropic).
	// Phase 5: ESCALATE decisions are logged to the escalation corpus for
	// the apprentice→teacher training loop.
	if (!body.provider && hybridVerdict.decision === 'LOCAL') {
		(ctx as { provider: string; currentTier: string }).provider = 'local';
		(ctx as { provider: string; currentTier: string }).currentTier = 'local';
		fallbackReason = `hybrid: local (${hybridVerdict.source} / ${hybridVerdict.why})`;
	} else if (hybridVerdict.decision === 'ESCALATE') {
		fallbackReason = `hybrid: escalate (${hybridVerdict.source} / ${hybridVerdict.why})`;
	}

	// Pre-flight cap check for explicit Anthropic picks.
	if (ctx.provider === 'anthropic') {
		const fallback = pickFallbackModel();
		if (fallback && isAnthropicCapExceeded()) {
			modelHandle = fallback;
			(ctx as { provider: string }).provider = 'local';
			fallbackReason = 'anthropic daily cap exceeded';
		}
	}

	if (!modelHandle) {
		try {
			modelHandle = resolveDirectModel({ ctx, requestedModel: body.model });
		} catch (err) {
			if (ctx.provider === 'anthropic') {
				const fb = resolveAutoFallback(ctx.currentTier);
				modelHandle = fb.modelHandle;
				(ctx as { provider: string }).provider = 'local';
				routing = fb.route;
				fallbackReason = 'anthropic credential unavailable';
			}
			if (!modelHandle) {
				rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
				const frame = sullyErrorFrame('credential_unavailable', (err as Error).message);
				return new Response(
					JSON.stringify({ error: 'credential_unavailable', detail: frame.message, ...frame }),
					{ status: 503, headers: { 'Content-Type': 'application/json' } }
				);
			}
		}
	}

	if (!routing) {
		routing = routingFrameForExplicitPick({
			ctx,
			modelId: modelHandle.modelId,
			fell_forward: Boolean(fallbackReason),
			fallbackReason
		});
	}

	const tools = ctx.allowSensitive ? { ...baseTools, ...getSensitiveTools() } : baseTools;

	// Phase 5: log ESCALATE decisions to the training corpus so the local
	// model can learn from what the specialist handles.
	if (hybridVerdict.decision === 'ESCALATE') {
		logEscalation({
			ts: new Date().toISOString(),
			thread: threadId,
			text_head: userText.slice(0, 200),
			reason: `${hybridVerdict.source}: ${hybridVerdict.why}`,
			model_used: modelHandle.modelId
		});
	}

	if (ctx.provider === 'local') {
		return handleLocalReply({ ctx, request, model: modelHandle.model, tools, routing });
	}
	return handleDirectReply({ ctx, request, modelHandle, tools, routing });
};
