// POST /api/chat/push/unsubscribe
// Client sends { device_id: string }.
// Server deletes the subscription row.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { removeSubscription } from '$lib/server/web_push';

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, { message: 'Invalid JSON body.' });
	}

	const { device_id } = body as Record<string, unknown>;
	if (typeof device_id !== 'string' || !device_id.trim()) {
		throw error(400, { message: 'device_id is required.' });
	}

	removeSubscription(device_id.trim());

	return json({ ok: true });
};
