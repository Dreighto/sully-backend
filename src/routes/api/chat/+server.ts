import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getChatMessages, getChatMessagesSince, deleteChatMessage } from '$lib/server/chat';
import { runMode } from '$lib/server/config';
import { buildChatPostContext } from '$lib/server/chat/legacy_context';
import { handleCompanionDispatch } from '$lib/server/chat/legacy_companion_dispatch';
import { handleConversationalChat } from '$lib/server/chat/legacy_conversation';
import { handleHermes } from '$lib/server/chat/legacy_hermes';
import { handleImageGeneration } from '$lib/server/chat/legacy_image';
import { handleKernelDispatch } from '$lib/server/chat/legacy_kernel_dispatch';

// buildSystemPrompt: extracted to $lib/server/chat_prompt.ts (PR C). The
// legacy route does not take the sdk-stream's allowSensitive flag (no SDK
// tools attached on this path) - pass allowSensitive: false.

export const GET: RequestHandler = async ({ url }) => {
	try {
		const limitParam = url.searchParams.get('limit');
		const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
		const thread = (url.searchParams.get('thread') || 'default').trim() || 'default';

		// Delta short-circuit (Tier-1 detached recovery): `since` is the last
		// message id the client holds. When provided, return only rows id > since
		// plus {latest_id, thread_updated} meta so a stale window can cheaply
		// confirm it is caught up. Omitting `since` keeps the original full-window
		// response shape — fully backward compatible.
		const sinceParam = url.searchParams.get('since');
		if (sinceParam !== null) {
			const since = Number.parseInt(sinceParam, 10);
			if (!Number.isFinite(since) || since < 0) {
				return json({ error: 'invalid since' }, { status: 400 });
			}
			const delta = getChatMessagesSince(
				since,
				thread,
				limitParam && Number.isFinite(limit) ? limit : undefined
			);
			return json({
				messages: delta.messages,
				latest_id: delta.latest_id,
				thread_updated: delta.thread_updated
			});
		}

		const messages = getChatMessages(limit, thread);
		return json({ messages });
	} catch (e: unknown) {
		console.error('GET /api/chat error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};

// DELETE /api/chat?id=<n>  - drop a single chat message by id. Used by the
// regenerate flow to remove the old assistant reply before re-streaming a
// new one. Operator-only (gated by the auth hook on /api/chat/*).
export const DELETE: RequestHandler = async ({ url }) => {
	try {
		const idStr = url.searchParams.get('id');
		const id = idStr ? Number.parseInt(idStr, 10) : NaN;
		if (!Number.isFinite(id) || id <= 0) {
			return json({ error: 'invalid id' }, { status: 400 });
		}
		const deleted = deleteChatMessage(id);
		return json({ deleted });
	} catch (e: unknown) {
		console.error('DELETE /api/chat error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const ctx = buildChatPostContext(body);
		if ('error' in ctx) {
			return json({ error: ctx.error }, { status: 400 });
		}

		if (ctx.shouldTrigger && !runMode.dispatchEnabled) {
			return handleCompanionDispatch(ctx);
		}

		if (ctx.isHermes && ctx.sender !== 'system') {
			await handleHermes(ctx);
		}

		let routerMeta: { provider_used: string; model_used: string } | null = null;
		if (ctx.shouldRouteChat) {
			({ routerMeta } = await handleConversationalChat(ctx));
		}

		if (ctx.imageMode && ctx.sender !== 'system') {
			await handleImageGeneration(ctx);
		}

		if (ctx.shouldTrigger && ctx.sender !== 'system') {
			await handleKernelDispatch(ctx);
		}

		// No else-branch: shouldTrigger is now false only when the operator
		// explicitly picked the Silent pill, in which case the chat message
		// is logged but no worker spawns. That's the entire intent - no
		// system "no dispatch" warning needed.
		return json({
			message: ctx.chatMsg,
			current_tier: ctx.currentTier,
			...(routerMeta
				? { provider_used: routerMeta.provider_used, model_used: routerMeta.model_used }
				: {})
		});
	} catch (e: unknown) {
		console.error('POST /api/chat error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
