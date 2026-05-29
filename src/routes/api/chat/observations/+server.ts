import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listChatObservations } from '$lib/server/observation_emit';

/**
 * GET /api/chat/observations?limit=50&offset=0
 * Returns chat-sourced Tier 0 observations with today/lifetime counts.
 */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const limit = Math.min(
			200,
			Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50)
		);
		const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);

		const result = listChatObservations(limit, offset);
		return json(result);
	} catch (e: unknown) {
		console.error('GET /api/chat/observations error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
