import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getChatMessages } from '$lib/server/chat';
import { setRememberFlag, getThreadMeta } from '$lib/server/thread_meta';
import { getThreadState } from '$lib/server/thread_state';
import { emitObservation } from '$lib/server/observation_emit';
import { routeChat } from '$lib/server/llm_router';
import { extractAndStoreEpisodicFacts } from '$lib/server/episode_extractor';

/**
 * POST /api/chat/threads/[thread_id]/remember
 * Sets remember_flag=true AND immediately fires a high-priority Tier 0 emission.
 * Body: { tag?: string } — optional operator-supplied note included in the body.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const { thread_id } = params;
	if (!thread_id) return json({ error: 'missing thread_id' }, { status: 400 });

	let tag = '';
	try {
		const body = await request.json().catch(() => ({}));
		if (typeof body.tag === 'string') tag = body.tag.trim().slice(0, 300);
	} catch {
		/* no body */
	}

	try {
		setRememberFlag(thread_id, true);

		const messages = getChatMessages(30, thread_id);

		// Layer 2 (episodic): extract + persist durable facts about Captain.
		try {
			await extractAndStoreEpisodicFacts(thread_id, messages);
		} catch (e) {
			console.error('episodic extraction failed:', e);
		}
		const threadState = getThreadState(thread_id);
		const threadMeta = getThreadMeta(thread_id);

		// Build a summary of the thread for the observation body.
		let summaryBody = '';
		const recentExchange = messages
			.filter((m) => m.sender !== 'system')
			.slice(-6)
			.map((m) => `${m.sender === 'operator' ? 'User' : 'Agent'}: ${m.message.slice(0, 200)}`)
			.join('\n');

		if (recentExchange) {
			try {
				const prompt = `Summarize this conversation in 1-2 sentences as a Tier 0 observation for a team memory system. Focus on the key technical insight or decision made. Return ONLY the summary text.\n\n${recentExchange}`;
				const result = await routeChat('chat', [{ role: 'user', content: prompt }], 'gemini');
				summaryBody = result.reply.trim().slice(0, 500);
			} catch {
				// Fall back to thread title or tag
				summaryBody =
					(threadMeta?.title && threadMeta.title !== 'New thread' ? threadMeta.title : '') ||
					tag ||
					`Manual remember flag set on thread "${thread_id}".`;
			}
		} else {
			summaryBody = tag || `Manual remember flag set on thread "${thread_id}".`;
		}

		if (tag) {
			summaryBody = `[${tag}] ${summaryBody}`;
		}

		const taskShape = ['chat', 'manual-remember', `thread:${thread_id.slice(0, 40)}`];
		const tier = threadState.current_tier ?? 'chat';

		const emitResult = emitObservation({
			source: 'chat_thread',
			thread_id,
			tier_at_emit: tier,
			models_used: threadState.last_model_used ? [threadState.last_model_used] : [],
			project_id: 'LogueOS-Console',
			task_shape: taskShape,
			body: summaryBody,
			observation_kind: 'what-worked'
		});

		if (!emitResult.ok) {
			console.error('POST /remember: emitObservation failed:', emitResult.reason);
			// Still return ok — the flag was set; emission failure is logged but
			// not surfaced to the operator (fail-closed means no key leaks, not UI errors).
			return json({ ok: true, observation_id: null, emit_error: emitResult.reason });
		}

		return json({ ok: true, observation_id: emitResult.observation_id });
	} catch (e) {
		console.error('POST /api/chat/threads/:id/remember error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
