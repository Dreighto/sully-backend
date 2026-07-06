// Artifact listing + single-file serving for work-surface State C.
// Tailscale is the auth boundary — no app-level session gate on these routes.
//
// TODO(Sully-direct emission): when Sully posts inline artifacts from chat, workers
// should write to data/sully_artifacts/<thread_id>/<msg_id>/ and emit chat_activity
// rows pointing at those paths. Wire a sully-* trace prefix + thread-scoped bundle
// once Phase 5c lands — see project_artifact_output_system_required.md.
//
// Wave 3 split (2026-07-06): DB probe moved to ./_artifactDb.ts, listing/index
// concerns to ./_artifactListing.ts, file-serving (thumbnails, MIME, path
// safety, header building) to $lib/server/artifactFileServing.ts, and the
// generic ZIP writer to $lib/server/zipBuilder.ts. This file keeps only the
// bundle-building glue plus a re-export barrel so the 4 sibling route files
// need no import-path changes.

import fs from 'node:fs';
import path from 'node:path';
import { assertInsideWorkspace } from '$lib/server/artifactFileServing';
import { buildZip } from '$lib/server/zipBuilder';
import { getTraceWorkspacePath, listArtifactsForTrace } from './_artifactListing';

export {
	type ArtifactListResponse,
	type AllArtifactsResponse,
	getTraceWorkspacePath,
	listArtifactsForTrace,
	listAllArtifacts,
	findArtifactMetadata
} from './_artifactListing';
export {
	ensureThumb,
	mimeFromExtension,
	resolveArtifactFile,
	assertInsideWorkspace,
	metadataHeaders
} from '$lib/server/artifactFileServing';
export { buildZip } from '$lib/server/zipBuilder';

export function buildBundleZip(traceId: string): Buffer | null {
	const listing = listArtifactsForTrace(traceId);
	if (!listing) return null;

	const zipEntries: { path: string; data: Buffer }[] = [
		{ path: 'manifest.json', data: Buffer.from(JSON.stringify(listing.artifacts, null, 2), 'utf8') }
	];

	// Resolve bytes against the ACTUAL current store dir (findStoreDir), NOT the
	// manifest's workspace_path — that field is STALE for artifacts migrated from
	// a retired repo (e.g. LogueOS-Companion), so the old path no longer exists and
	// the bundle would ship manifest-only with zero file bytes. Mirror the
	// single-file route (findArtifactMetadata): prefer the trace's real store dir,
	// fall back to workspace_path only when it can't be resolved.
	const storeDir = getTraceWorkspacePath(traceId);

	for (const meta of listing.artifacts) {
		const baseDir = storeDir ?? meta.workspace_path;
		try {
			const absolutePath = path.resolve(baseDir, meta.original_path);
			assertInsideWorkspace(baseDir, absolutePath);
			if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
			zipEntries.push({
				path: meta.original_path.replace(/\\/g, '/'),
				data: fs.readFileSync(absolutePath)
			});
		} catch {
			// Skip missing/unreadable artifacts — manifest still lists them.
		}
	}

	return buildZip(zipEntries);
}

export function bundleFilename(traceId: string): string {
	const date = new Date().toISOString().slice(0, 10);
	const safe = traceId.replace(/[^\w.-]+/g, '_').slice(0, 80);
	return `task-${safe}-${date}.zip`;
}
