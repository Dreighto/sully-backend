import { json } from '@sveltejs/kit';
import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { getActivityForTrace, getRecentActivity, writeActivity } from '$lib/server/chatActivity';
import { runMode, serverConfig } from '$lib/server/config';
import { markWorking, markDone, markFailed, getJob } from '$lib/server/dispatchJobs';
import { captureActualTokens, type ResultMarker } from '$lib/server/dispatchUsage';

export const GET: RequestHandler = async ({ url }) => {
	// Worker-activity feed is available when EITHER the kernel is wired OR the
	// companion-native dispatcher is enabled (Phase 1). Otherwise idle.
	if (!runMode.kernelWired && !runMode.companionDispatchEnabled) {
		return json({ activity: [] });
	}
	try {
		const traceId = url.searchParams.get('trace_id');
		const limitParam = url.searchParams.get('limit');
		const limit = limitParam ? Math.max(1, Math.min(500, Number.parseInt(limitParam, 10))) : 200;
		if (traceId) return json({ activity: getActivityForTrace(traceId, limit) });
		return json({ activity: getRecentActivity(limit) });
	} catch (e: unknown) {
		console.error('GET /api/chat/activity error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};

// POST — the dispatched worker calls back here to stream its activity into
// companion.db (it can't reach the DB directly). HMAC-authed; fail closed.
export const POST: RequestHandler = async ({ request }) => {
	if (!runMode.companionDispatchEnabled) {
		return json({ error: 'dispatch_disabled' }, { status: 404 });
	}
	const secret = serverConfig.companionCallbackSecret;
	const raw = await request.text();
	if (!secret) return json({ error: 'callback_auth_unconfigured' }, { status: 401 });
	const provided = request.headers.get('x-companion-hmac') || '';
	const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
	if (
		provided.length !== expected.length ||
		!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
	) {
		return json({ error: 'hmac_reject' }, { status: 401 });
	}
	let body: {
		trace_id?: string;
		action?: string;
		target?: string | null;
		result_ref?: string | null;
		marker?: ResultMarker;
	};
	try {
		body = JSON.parse(raw);
	} catch {
		return json({ error: 'malformed_json' }, { status: 400 });
	}
	const { trace_id, action } = body;
	if (!trace_id || !action) return json({ error: 'trace_id_and_action_required' }, { status: 400 });
	if (!getJob(trace_id)) return json({ error: 'unknown_trace' }, { status: 404 });

	// Always log the raw activity row for the bubble/SSE.
	writeActivity(trace_id, action, body.target ?? null);

	try {
		if (action === 'completed') {
			if (body.marker) captureActualTokens(trace_id, body.marker);
			markDone(trace_id, body.result_ref ?? null);
		} else if (action === 'failed') {
			markFailed(trace_id, body.target ?? null);
		} else {
			markWorking(trace_id, body.target ? `${action} ${body.target}` : action);
		}
	} catch (e) {
		// Illegal transition (e.g. duplicate completed) — row already logged.
		console.warn('activity callback transition skipped:', e);
	}
	return json({ ok: true });
};
