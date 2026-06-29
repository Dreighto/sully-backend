// GET /companion/api/artifacts → index of ALL promoted artifacts, newest first.
// Backs the Artifacts library surface in the SwiftUI app. Tailscale is the auth
// boundary (no app-level session gate, same as the per-trace route).
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAllArtifacts } from './_artifactService';

export const GET: RequestHandler = async ({ url }) => {
	const limitParam = Number(url.searchParams.get('limit'));
	const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 2000) : 500;
	return json(listAllArtifacts(limit));
};
