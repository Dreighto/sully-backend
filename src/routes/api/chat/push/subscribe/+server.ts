// POST /api/chat/push/subscribe
// Client sends { device_id: string, subscription: PushSubscription.toJSON() }.
// Server upserts to chat_web_push_subscriptions.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { upsertSubscription } from '$lib/server/web_push';
import { serverConfig } from '$lib/server/config';

export const POST: RequestHandler = async ({ request }) => {
	if (!serverConfig.enableWebPush) {
		throw error(503, { message: 'Web Push is disabled (ENABLE_WEB_PUSH=false).' });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, { message: 'Invalid JSON body.' });
	}

	const { device_id, subscription } = body as Record<string, unknown>;

	if (typeof device_id !== 'string' || !device_id.trim()) {
		throw error(400, { message: 'device_id is required.' });
	}
	if (!subscription || typeof subscription !== 'object') {
		throw error(400, { message: 'subscription is required.' });
	}

	const sub = subscription as { endpoint?: unknown };
	if (typeof sub.endpoint !== 'string' || !sub.endpoint) {
		throw error(400, { message: 'subscription.endpoint is required.' });
	}

	upsertSubscription(device_id.trim(), JSON.stringify(subscription));

	return json({ ok: true });
};
