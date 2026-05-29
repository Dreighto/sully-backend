import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getActivityForTrace, getRecentActivity } from '$lib/server/chatActivity';

export const GET: RequestHandler = async ({ url }) => {
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
