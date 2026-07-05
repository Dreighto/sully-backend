// GET /api/chat/spend — read-only USD spend rollup for the Ops dashboard.
// Aggregates the four usage tables over the last 30 days. See spend.ts.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSpend } from '$lib/server/spend';

export const GET: RequestHandler = async () => {
	try {
		return json(getSpend(30));
	} catch (e) {
		console.error('GET /api/chat/spend error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
