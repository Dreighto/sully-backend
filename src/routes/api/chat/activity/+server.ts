import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getActivityForTrace, getRecentActivity, writeActivity } from '$lib/server/chatActivity';
import { runMode } from '$lib/server/config';
import { markWorking, markDone, markFailed, getJob, reapStaleJobs } from '$lib/server/dispatchJobs';
import { captureActualTokens, type ResultMarker } from '$lib/server/dispatchUsage';
import { closeOutTask, resolveCompletionThread } from '$lib/server/completionClose';
import { addChatMessage } from '$lib/server/chat';

// The client polls this GET every ~3s; piggyback a throttled stale-job sweep on
// it so a dropped worker is surfaced without a separate timer. Throttle to once
// per 60s to keep the poll cheap.
let _lastReapMs = 0;
function maybeReap(): void {
	const now = Date.now();
	if (now - _lastReapMs < 60_000) return;
	_lastReapMs = now;
	try {
		for (const job of reapStaleJobs()) {
			const threadId = resolveCompletionThread(job.thread_id);
			addChatMessage(
				'local',
				`That task stalled — the worker never reported back. Want me to retry it?`,
				job.trace_id,
				null,
				null,
				'sent',
				threadId,
				{ taskId: job.trace_id }
			);
		}
	} catch (e) {
		console.warn('[activity] reap sweep skipped:', e);
	}
}

export const GET: RequestHandler = async ({ url }) => {
	// Worker-activity feed is available when EITHER the kernel is wired OR the
	// companion-native dispatcher is enabled (Phase 1). Otherwise idle.
	if (!runMode.kernelWired && !runMode.companionDispatchEnabled) {
		return json({ activity: [] });
	}
	try {
		maybeReap();
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
			// Decoupled: a 'completed' callback that lands after the job already
			// went terminal (e.g. aborted) throws an illegal transition — but the
			// result must STILL reach the operator, so close out regardless.
			try {
				markDone(trace_id, body.result_ref ?? null);
			} catch (e) {
				console.warn('activity markDone transition skipped:', e);
			}
			closeOutTask(trace_id, 'done', body.result_ref ?? '');
		} else if (action === 'failed') {
			try {
				markFailed(trace_id, body.target ?? null);
			} catch (e) {
				console.warn('activity markFailed transition skipped:', e);
			}
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
