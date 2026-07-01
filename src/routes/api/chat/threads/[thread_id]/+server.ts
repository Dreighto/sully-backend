import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	setPin,
	setArchived,
	setTitle,
	setRememberFlag,
	softDeleteThread,
	hardDeleteThreadCascade,
	getThreadMeta
} from '$lib/server/thread_meta';
import { getChatMessages } from '$lib/server/chat';
import { getThreadState } from '$lib/server/thread_state';
import { emitObservation } from '$lib/server/observation_emit';
import { routeChat } from '$lib/server/llm_router';

/**
 * PATCH /api/chat/threads/[thread_id]
 * Body: { title?, pinned?, archived?, remember_flag? }
 * Applies only the fields present in the body.
 * When archived=true, fires an async Tier 0 emission summarising the thread.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const { thread_id } = params;
	if (!thread_id) return json({ error: 'missing thread_id' }, { status: 400 });

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid_json' }, { status: 400 });
	}

	try {
		if (typeof body.title === 'string') {
			setTitle(thread_id, body.title);
		}
		if (typeof body.pinned === 'boolean') {
			setPin(thread_id, body.pinned);
		}
		if (typeof body.archived === 'boolean') {
			setArchived(thread_id, body.archived);
			if (body.archived) {
				// Fire async archive-emission — don't await, keep response fast.
				void emitArchiveObservation(thread_id);
			}
		}
		if (typeof body.remember_flag === 'boolean') {
			setRememberFlag(thread_id, body.remember_flag);
		}
		return json({ ok: true });
	} catch (e) {
		console.error('PATCH /api/chat/threads/:id error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};

/**
 * DELETE /api/chat/threads/[thread_id]
 *
 * Default = SOFT delete (Recently Deleted trash): stamps deleted_at=now, moving
 * the thread out of the active list into recentlyDeleted. Restorable for 90 days,
 * then lazily hard-purged. There is NO archived-first gate on the soft path — the
 * operator pressing Delete always succeeds into the trash.
 *
 * ?permanent=true = Delete-Now: an immediate, FULL hard-delete cascade
 * (chat_messages + chat_drafts + chat_thread_state + observations + pending_jobs
 * + chat_thread_meta + on-disk artifacts) so nothing orphans.
 */
export const DELETE: RequestHandler = async ({ params, url }) => {
	const { thread_id } = params;
	if (!thread_id) return json({ error: 'missing thread_id' }, { status: 400 });

	const permanent = url.searchParams.get('permanent') === 'true';
	const result = permanent ? hardDeleteThreadCascade(thread_id) : softDeleteThread(thread_id);

	if (!result.ok) {
		const reason = (result as { reason?: string }).reason;
		if (reason === 'db_not_found' || reason === 'thread_not_found') {
			return json({ error: 'thread_not_found' }, { status: 404 });
		}
		return json({ error: reason ?? 'internal_server_error' }, { status: 500 });
	}

	return json({ ok: true });
};

/**
 * Generate a summary via Flash-lite and emit a Tier 0 observation for an
 * archived thread. Runs async (fire-and-forget from the PATCH handler).
 */
async function emitArchiveObservation(thread_id: string): Promise<void> {
	try {
		const messages = getChatMessages(30, thread_id);
		const threadState = getThreadState(thread_id);
		const threadMeta = getThreadMeta(thread_id);

		const recentExchange = messages
			.filter((m) => m.sender !== 'system')
			.slice(-10)
			.map((m) => `${m.sender === 'operator' ? 'User' : 'Agent'}: ${m.message.slice(0, 300)}`)
			.join('\n');

		if (!recentExchange) return;

		let summaryBody = '';
		try {
			const prompt = `Summarize this conversation in 2-3 sentences as a Tier 0 observation for a team memory system. Focus on key technical insights, decisions, or patterns. Return ONLY the summary text.\n\n${recentExchange}`;
			const result = await routeChat('chat', [{ role: 'user', content: prompt }], 'gemini');
			summaryBody = result.reply.trim().slice(0, 500);
		} catch {
			summaryBody =
				threadMeta?.title && threadMeta.title !== 'New thread'
					? `Thread "${threadMeta.title}" archived.`
					: `Thread "${thread_id}" archived.`;
		}

		const tier = threadState.current_tier ?? 'chat';

		const emitResult = emitObservation({
			source: 'chat_thread',
			thread_id,
			tier_at_emit: tier,
			models_used: threadState.last_model_used ? [threadState.last_model_used] : [],
			project_id: 'LogueOS-Console',
			task_shape: ['chat', 'archive', `thread:${thread_id.slice(0, 40)}`],
			body: summaryBody,
			observation_kind: 'what-worked'
		});

		if (!emitResult.ok) {
			console.error('emitArchiveObservation failed:', emitResult.reason);
		}
	} catch (e) {
		console.error('emitArchiveObservation error:', e);
	}
}
