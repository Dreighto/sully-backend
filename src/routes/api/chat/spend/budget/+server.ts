// GET /api/chat/spend/budget — read the server-side monthly budget.
// POST /api/chat/spend/budget — set the server-side monthly budget.
// Persists in the companion DB so the budget survives app reinstalls
// and is shared across devices.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBudget, setBudget } from '$lib/server/spend';

export const GET: RequestHandler = async () => {
	try {
		return json({ budget: getBudget() });
	} catch (e) {
		console.error('GET /api/chat/spend/budget error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const amount = Number(body?.amount);
		if (!Number.isFinite(amount) || amount < 0) {
			return json({ error: 'invalid_amount' }, { status: 400 });
		}
		setBudget(amount);
		return json({ ok: true, budget: amount });
	} catch (e) {
		console.error('POST /api/chat/spend/budget error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
