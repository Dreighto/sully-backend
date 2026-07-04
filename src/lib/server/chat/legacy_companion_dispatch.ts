import { json } from '@sveltejs/kit';
import { addChatMessage } from '$lib/server/chat';
import { runMode } from '$lib/server/config';
import { dispatchToWorker } from '$lib/server/companionDispatch';
import type { ChatPostContext } from '$lib/server/chat/legacy_context';

export async function handleCompanionDispatch(ctx: ChatPostContext): Promise<Response> {
	// Companion-native dispatch (Phase 1). When enabled, an explicit
	// @cc/@agy intent reaches a worker via the dispatch listener (HMAC) and
	// the worker streams activity back into companion.db. The KERNEL gateway
	// path (runMode.dispatchEnabled) stays OFF in companion mode.
	if (runMode.companionDispatchEnabled) {
		// Use the effective task id so a reused turn's dispatch attaches to its
		// original Task rather than a fresh, orphaned handle.
		const traceId = ctx.effectiveTaskId;
		// `worker` was resolved above to 'claude-code' | 'agy' | 'auto'.
		// Spec §4.3: emit 'gemini' (the listener-accepted frontend name).
		const dispatchWorker = ctx.worker === 'claude-code' ? 'claude-code' : 'gemini';
		const res = await dispatchToWorker({
			traceId,
			worker: dispatchWorker,
			category: 'code',
			brief: ctx.normalizedMessage.trim().slice(0, 200),
			targetRepo: ctx.targetRepo,
			task: ctx.normalizedMessage.trim(),
			threadId: ctx.threadId
		});
		if (res.ok) {
			addChatMessage(
				'system',
				// Card-only in the UI (the morphing Task card renders this row); text
				// kept clean + trace-free for the stored record / non-UI surfaces.
				`Handing this to ${dispatchWorker === 'claude-code' ? 'CC' : 'AGY'}.`,
				traceId,
				ctx.ticketId,
				null,
				'sent',
				ctx.threadId
			);
		} else {
			addChatMessage(
				'system',
				`⚠️ Dispatch held: ${res.reason}.`,
				null,
				ctx.ticketId,
				null,
				'sent',
				ctx.threadId
			);
		}
		return json({ ok: true, trace_id: traceId });
	}

	// Companion mode WITHOUT the dispatch flag: @cc/@agy is unavailable.
	addChatMessage(
		'system',
		'Worker dispatch (@cc / @agy) is a kernel feature and is not available in the Companion — this app talks to your local model. Just ask me directly.',
		null,
		null,
		null,
		'sent',
		ctx.threadId
	);
	return json({ ok: true });
}
