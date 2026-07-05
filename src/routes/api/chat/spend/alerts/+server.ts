// GET /api/chat/spend/alerts — cap warnings for the Ops dashboard.
// Returns a list of alerts when daily token caps or monthly budgets
// are approaching or have been reached.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAlerts } from '$lib/server/spend';

export const GET: RequestHandler = async () => {
	try {
		return json(getAlerts());
	} catch (e) {
		console.error('GET /api/chat/spend/alerts error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
