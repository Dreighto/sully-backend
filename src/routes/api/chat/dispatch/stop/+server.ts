/**
 * POST /api/chat/dispatch/stop
 *
 * Aborts a running dispatch from the work-surface Stop button. Two steps,
 * mirroring companionDispatch.killAll() for a single trace:
 *   1. killWorker(traceId) — POSTs HMAC-signed /kill to the kernel listener
 *      (:19100), which SIGTERMs the worker PID and releases the worktree slot.
 *      The HMAC is added server-side inside killWorker — the browser sends none.
 *   2. markAborted(traceId) — closes the FSM row (running states → aborted).
 *
 * markAborted alone is NOT enough: it only flips the DB row; the OS worker
 * keeps running. If the listener is down / has no lease, we still markAborted
 * so the FSM + UI reflect operator intent, and surface the reason in kill_note.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { killWorker, DispatchListenerError } from '$lib/server/dispatch-listener';
import { getJob, markAborted, RUNNING_STATES } from '$lib/server/dispatchJobs';

export const POST: RequestHandler = async ({ request }) => {
	let body: { trace_id?: string };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid_json');
	}
	const traceId = body?.trace_id;
	if (typeof traceId !== 'string' || !traceId) throw error(400, 'trace_id required');

	const jobRow = getJob(traceId);
	if (!jobRow) throw error(404, 'trace_not_found');

	// Idempotent: terminal rows are a no-op success so a double-tap Stop is safe.
	if (!RUNNING_STATES.has(jobRow.status)) {
		return json({ ok: true, already_terminal: true, status: jobRow.status });
	}

	// Step 1 — stop the actual worker process via the kernel listener.
	let killResult: { killed_pid: number | null; released_slot: string | null } | null = null;
	let killNote: string | null = null;
	try {
		const r = await killWorker(traceId);
		killResult = { killed_pid: r.killed_pid, released_slot: r.released_slot };
	} catch (e) {
		killNote = e instanceof DispatchListenerError ? `${e.message} (status ${e.status})` : String(e);
	}

	// Step 2 — close the FSM row. Running states all permit → aborted.
	try {
		markAborted(traceId);
	} catch {
		/* already terminal — fine */
	}

	return json({ ok: true, trace_id: traceId, ...(killResult ?? {}), kill_note: killNote });
};
