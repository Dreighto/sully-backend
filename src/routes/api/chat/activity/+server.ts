import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getActivityForTrace, getRecentActivity } from '$lib/server/chatActivity';
import { runMode } from '$lib/server/config';

export const GET: RequestHandler = async ({ url }) => {
	// Worker-activity feed is kernel-only (dispatch writes chat_activity). In
	// companion mode there is no activity — return empty so the pill stays idle.
	if (!runMode.kernelWired) return json({ activity: [] });
	try {
		const traceId = url.searchParams.get('trace_id');
		const limitParam = url.searchParams.get('limit');
		const limit = limitParam ? Math.max(1, Math.min(500, Number.parseInt(limitParam, 10))) : 200;

		if (traceId) {
			return json({ activity: getActivityForTrace(traceId, limit) });
		}
		// No trace_id specified: return recent activity across all traces. The
		// chat client uses this to bootstrap state on first paint, then polls
		// per-trace once it knows which traces are tied to its messages.
		return json({ activity: getRecentActivity(limit) });
	} catch (e: unknown) {
		console.error('GET /api/chat/activity error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
