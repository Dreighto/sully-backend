import fs from 'node:fs';
import path from 'node:path';
import { findStoreDir, readManifest, artifactRepoRoot, storeRoot } from '$lib/server/artifactStore';
import type { ArtifactMetadata } from '$lib/server/artifactStore';
import { getJob } from './_artifactDb';
import { assertInsideWorkspace } from '$lib/server/artifactFileServing';

const APP_BASE = '/companion';

export interface ArtifactListResponse {
	trace_id: string;
	task_id: string;
	artifacts: ArtifactMetadata[];
	count: number;
	bundle_url: string;
}

export function getTraceWorkspacePath(traceId: string): string | null {
	const repoRoot = artifactRepoRoot();
	return findStoreDir(repoRoot, traceId);
}

export function listArtifactsForTrace(traceId: string): ArtifactListResponse | null {
	const job = getJob(traceId);

	// A promoted artifact lives in the DURABLE store and must stay reachable even
	// after the (ephemeral) job row is reaped — that is the entire point of the
	// durable store ("survives worktree deletion / job cleanup"). So gate on the
	// store dir, NOT the job row. Only 404 when there is NEITHER a job NOR a
	// promoted store dir. (Previously `if (!job) return null` made promoted
	// artifacts 404 the moment reapStaleJobs deleted the job — see the live
	// repro where a completed task's files vanished from the UI.)
	const repoRoot = artifactRepoRoot();
	const storeDir = findStoreDir(repoRoot, traceId);
	if (!job && !storeDir) return null;

	const taskId = (job?.ticket_id as string | null) ?? traceId;
	const bundle_url = `${APP_BASE}/api/artifacts/${encodeURIComponent(traceId)}/bundle.zip`;

	// Read from the durable manifest (sole source of truth), not activity rows.
	if (!storeDir) {
		return { trace_id: traceId, task_id: taskId, artifacts: [], count: 0, bundle_url };
	}

	const manifest = readManifest(storeDir);
	return {
		trace_id: traceId,
		task_id: taskId,
		artifacts: manifest,
		count: manifest.length,
		bundle_url
	};
}

export interface AllArtifactsResponse {
	artifacts: ArtifactMetadata[];
	count: number;
}

/**
 * Index of ALL promoted artifacts across every trace, newest first. Backs the
 * Artifacts LIBRARY surface (GET /api/artifacts) — the tap-through view of every
 * output a dispatched worker produced, with provenance (source_worker, trace_id,
 * task_id, artifact_type, timestamp) already carried on each ArtifactMetadata.
 * Scans the same durable store as listArtifactsForTrace
 * (data/sully/artifacts/<date>/<trace>/manifest.json), just unfiltered.
 */
export function listAllArtifacts(limit = 500): AllArtifactsResponse {
	const root = storeRoot(artifactRepoRoot());
	const all: ArtifactMetadata[] = [];
	let dates: string[];
	try {
		dates = fs.readdirSync(root);
	} catch {
		return { artifacts: [], count: 0 };
	}
	for (const date of dates) {
		const dateDir = path.join(root, date);
		let traces: string[];
		try {
			traces = fs.readdirSync(dateDir);
		} catch {
			continue;
		}
		for (const trace of traces) {
			const dir = path.join(dateDir, trace);
			if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue;
			for (const a of readManifest(dir)) all.push(a);
		}
	}
	// Newest first by ISO timestamp.
	all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
	const sliced = all.slice(0, limit);
	return { artifacts: sliced, count: sliced.length };
}

export function findArtifactMetadata(
	traceId: string,
	filepathParts: string[]
): { meta: ArtifactMetadata; absolutePath: string } | null {
	const listing = listArtifactsForTrace(traceId);
	if (!listing) return null;

	const requested = filepathParts.join('/').replace(/\\/g, '/');
	const meta = listing.artifacts.find((a) => a.original_path === requested);
	if (!meta) return null;

	// Resolve against the ACTUAL current store dir (findStoreDir), NOT the
	// manifest's workspace_path — that field is STALE for artifacts migrated from
	// a retired repo (e.g. LogueOS-Companion), so assertInsideWorkspace would
	// throw on the nonexistent old path and 404 a file that's present in the new
	// store. The bytes always live next to the manifest we just read.
	const storeDir = getTraceWorkspacePath(traceId) ?? meta.workspace_path;
	try {
		const absolutePath = path.resolve(storeDir, meta.original_path);
		assertInsideWorkspace(storeDir, absolutePath);
		return { meta, absolutePath };
	} catch {
		return null;
	}
}
