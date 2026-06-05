// Full-history message search. GET /api/chat/search?q=<term>[&limit=30]
// Returns matches across all threads, each annotated with thread title.
// Used by the ThreadsSidebar search input.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchChatMessages } from '$lib/server/chat';

export const GET: RequestHandler = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim();
	if (!q) {
		return json({ results: [] });
	}
	const limitParam = url.searchParams.get('limit');
	const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 30), 100) : 30;
	try {
		const results = searchChatMessages(q, limit);
		return json({ results });
	} catch (e) {
		console.error('GET /api/chat/search error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
