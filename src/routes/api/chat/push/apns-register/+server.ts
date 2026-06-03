// Native iOS push registration. The Capacitor app, after the operator grants
// notification permission, gets an APNs device token and POSTs it here so the
// server can push task-completion alerts. Tailnet-gated like the other push
// routes (the operator's own device only; the public Funnel is rejected).
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { upsertApnsToken } from '$lib/server/apns';

export const POST: RequestHandler = async ({ request }) => {
	// Reject public-Funnel callers — token registration is operator-device only.
	if (request.headers.get('tailscale-funnel-request') !== null) {
		return json({ error: 'forbidden_public' }, { status: 401 });
	}
	let body: { token?: string; device_id?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'malformed_json' }, { status: 400 });
	}
	const token = (body.token || '').trim();
	const deviceId = (body.device_id || '').trim() || 'default-device';
	if (!token) return json({ error: 'token_required' }, { status: 400 });
	upsertApnsToken(deviceId, token);
	return json({ ok: true });
};
