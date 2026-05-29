// POST /api/chat/push/notify
// Internal endpoint — receives { title, body, url } and sends a push to all
// stored subscriptions. Called by the completion poller (src/lib/server/
// completion_poller.ts) and any future kernel-side webhook.
//
// Reachable only from tailnet-direct (Tailscale Funnel requests are blocked
// by hooks.server.ts like all /api/chat/* routes).

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sendPushToAll } from '$lib/server/web_push';
import { serverConfig } from '$lib/server/config';

export const POST: RequestHandler = async ({ request }) => {
	if (!serverConfig.enableWebPush) {
		return json({ ok: true, sent: 0, failed: 0, skipped: 'disabled' });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, { message: 'Invalid JSON body.' });
	}

	const { title, body: msgBody, url } = body as Record<string, unknown>;

	if (typeof title !== 'string' || !title.trim()) {
		throw error(400, { message: 'title is required.' });
	}

	const result = await sendPushToAll({
		title: title.trim(),
		body: typeof msgBody === 'string' ? msgBody.trim() : '',
		url: typeof url === 'string' ? url.trim() : '/console'
	});

	return json({ ok: true, ...result });
};
