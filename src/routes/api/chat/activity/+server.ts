import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getActivityForTrace,
	getRecentActivity,
	writeActivity,
	logTaskEvent
} from '$lib/server/chatActivity';
import { runMode, appIdentity } from '$lib/server/config';
import {
	markWorking,
	markDone,
	markFailed,
	markSynthesized,
	getJob
} from '$lib/server/dispatchJobs';
import { captureActualTokens, type ResultMarker } from '$lib/server/dispatchUsage';
import { addChatMessage } from '$lib/server/chat';
import { sendPushToAll } from '$lib/server/web_push';

/**
 * On a Task reaching a terminal state, close the loop for the operator:
 *   1. Post a Sully-voiced chat message with the worker's result (so the
 *      "I'll drop the answer right here" promise made at dispatch is real —
 *      previously markDone only touched the DB and nothing posted).
 *   2. Fire a push notification ("ping me when done"). sendPushToAll
 *      self-gates on ENABLE_WEB_PUSH, so this is a safe no-op until push is
 *      turned on + a device has subscribed.
 *   3. Link the synthesis message to the Task + advance it to 'synthesized'.
 * All best-effort — never throw back into the worker's callback.
 */
function closeOutTask(traceId: string, outcome: 'done' | 'failed', resultText: string): void {
	const job = getJob(traceId);
	const threadId = job?.thread_id ?? 'default';
	const text = resultText.trim();
	const msg =
		outcome === 'done'
			? text
				? `Done. Here's what came back:\n\n${text}`
				: `That's finished — the task completed cleanly.`
			: text
				? `That one hit a snag: ${text}`
				: `That one didn't complete — I'll need another look.`;
	try {
		const row = addChatMessage('local', msg, traceId, null, null, 'sent', threadId, {
			taskId: traceId
		});
		logTaskEvent(traceId, 'synthesis_completed', { outcome, via: 'worker-result' });
		try {
			markSynthesized(traceId, row.id);
		} catch {
			/* FSM may not allow done→synthesized from a failed state; non-fatal */
		}
	} catch (e) {
		console.error('[activity] closeOutTask message failed', e);
	}
	void sendPushToAll({
		title: outcome === 'done' ? 'Sully — task done' : 'Sully — task needs you',
		body: outcome === 'done' ? 'Your task finished. Tap to see the result.' : 'A task hit a snag.',
		url: appIdentity.pushDefaultUrl
	}).catch((e) => console.error('[activity] push failed', e));
}

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
// companion.db (it can't reach the DB directly). Auth = the Tailscale boundary
// (see hooks.server.ts): the worker is co-located (loopback/tailnet), so a
// callback for a KNOWN in-flight job that did NOT arrive via the public Funnel
// is trusted. Public-Funnel callers are rejected, so guessing a trace_id over
// the public URL can't forge activity. No shared secret to distribute.
export const POST: RequestHandler = async ({ request }) => {
	if (!runMode.companionDispatchEnabled) {
		return json({ error: 'dispatch_disabled' }, { status: 404 });
	}
	const raw = await request.text();
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

	// The tailnet/loopback boundary is the auth (matches sdk-stream's Funnel
	// gate). Reject anything arriving via the public Funnel.
	if (request.headers.get('tailscale-funnel-request') !== null) {
		return json({ error: 'forbidden_public_callback' }, { status: 401 });
	}

	// Always log the raw activity row for the bubble/SSE.
	writeActivity(trace_id, action, body.target ?? null);

	try {
		if (action === 'completed') {
			if (body.marker) captureActualTokens(trace_id, body.marker);
			markDone(trace_id, body.result_ref ?? null);
			// Post the result into chat + ping the operator (self-gated push).
			closeOutTask(trace_id, 'done', body.result_ref ?? '');
		} else if (action === 'failed') {
			markFailed(trace_id, body.target ?? null);
			closeOutTask(trace_id, 'failed', body.target ?? '');
		} else {
			markWorking(trace_id, body.target ? `${action} ${body.target}` : action);
		}
	} catch (e) {
		// Illegal transition (e.g. duplicate completed) — row already logged.
		console.warn('activity callback transition skipped:', e);
	}
	return json({ ok: true });
};
