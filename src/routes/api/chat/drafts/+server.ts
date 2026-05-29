import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDraft, saveDraft } from '$lib/server/chat_drafts';

export const GET: RequestHandler = async ({ url }) => {
	const threadId = url.searchParams.get('thread_id') || 'default';
	const body = getDraft(threadId);
	return json({ thread_id: threadId, body });
};

export const PUT: RequestHandler = async ({ url, request }) => {
	const threadId = url.searchParams.get('thread_id') || 'default';
	let payload: { body?: unknown };
	try {
		payload = await request.json();
	} catch {
		return error(400, 'JSON body required');
	}
	const text = typeof payload.body === 'string' ? payload.body : '';
	saveDraft(threadId, text);
	return json({ ok: true });
};
