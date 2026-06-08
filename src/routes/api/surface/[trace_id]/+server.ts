/**
 * GET /api/surface/[trace_id]
 *
 * Returns the SeedSurface (hybrid work-surface shape) for a given trace_id.
 * Backed by liveSurfaceFromTrace() — reads pending_jobs + chat_activity from
 * companion.db / logueos_memory.db and maps to SeedSurface.
 *
 * Used by HybridSurfaceMount.svelte when the `?hybrid-surface=1` flag is on.
 * 404 if the trace is unknown.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { liveSurfaceFromTrace } from '$lib/server/surfaceAdapter';

export const GET: RequestHandler = async ({ params }) => {
	const traceId = params.trace_id;
	if (!traceId) {
		throw error(400, 'trace_id required');
	}
	const surface = await liveSurfaceFromTrace(traceId);
	if (!surface) {
		throw error(404, 'trace_not_found');
	}
	return json(surface);
};
