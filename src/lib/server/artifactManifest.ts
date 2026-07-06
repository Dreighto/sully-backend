import fs from 'node:fs';
import path from 'node:path';

export interface ArtifactMetadata {
	created_by: string;
	task_id: string;
	trace_id: string;
	timestamp: string;
	source_worker: string;
	workspace_path: string;
	artifact_type: string;
	original_path: string;
	artifact_url: string;
	label: string;
	importance: 'primary' | 'secondary' | 'supporting';
	/** Raster thumbnail URL (artifact_url + ?thumb=1) for image/svg types, else null. */
	thumb_url?: string | null;
	/** First ~400 chars for doc/code/data text tiles in the library, else null. */
	preview_text?: string | null;
	/** Programming language for code artifacts (drives the tile badge), else null. */
	language?: string | null;
	/** The conversation that produced this artifact (library grouping). */
	thread_id?: string | null;
	/** Source thread title, resolved at index time (not stored). */
	thread_title?: string | null;
}

export function storeRoot(repoRoot: string): string {
	return path.join(repoRoot, 'data/sully/artifacts');
}

/**
 * Repo root for the durable artifact store. Defaults to the process cwd (the
 * companion repo root in prod, matching the write side in closeOutTask). Tests
 * override it via LOGUEOS_ARTIFACT_REPO_ROOT so the read path is hermetic.
 */
export function artifactRepoRoot(): string {
	return process.env.LOGUEOS_ARTIFACT_REPO_ROOT || path.resolve(process.cwd());
}

export function storeDirFor(repoRoot: string, traceId: string, date: string): string {
	return path.join(storeRoot(repoRoot), date, traceId);
}

/** Glob-free trace lookup: scan date dirs for the trace (read path doesn't know the date). */
export function findStoreDir(repoRoot: string, traceId: string): string | null {
	const root = storeRoot(repoRoot);
	if (!fs.existsSync(root)) return null;
	for (const date of fs.readdirSync(root)) {
		const dir = path.join(root, date, traceId);
		if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
	}
	return null;
}

export function writeManifestAtomic(dir: string, meta: ArtifactMetadata[]): void {
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `manifest.json.${process.pid}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
	fs.renameSync(tmp, path.join(dir, 'manifest.json')); // atomic on same fs
}

export function readManifest(dir: string): ArtifactMetadata[] {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
		) as ArtifactMetadata[];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Thread hard-delete cascade — remove a thread's durable artifacts so nothing
// orphans on disk when the thread is purged/deleted. Two keying paths, unioned:
//   1. trace ids gathered from the thread's chat_messages / pending_jobs rows
//      (worker-promoted artifacts live at <store>/<date>/<traceId>/).
//   2. a full manifest scan for entries tagged thread_id === threadId (teacher
//      inline artifacts carry thread_id even when their synthetic trace never
//      lands on a chat_messages row).
// Returns the number of store dirs removed.
// ---------------------------------------------------------------------------
export function purgeThreadArtifacts(threadId: string, traceIds: string[] = []): number {
	const repoRoot = artifactRepoRoot();
	const dirs = new Set<string>();

	// 1. Resolve each trace id to its (date-partitioned) store dir.
	for (const tid of traceIds) {
		if (!tid) continue;
		try {
			const dir = findStoreDir(repoRoot, tid);
			if (dir) dirs.add(dir);
		} catch {
			/* unresolvable trace — nothing to remove */
		}
	}

	// 2. Scan manifests for any artifact tagged with this thread_id.
	const root = storeRoot(repoRoot);
	if (fs.existsSync(root)) {
		let dates: string[] = [];
		try {
			dates = fs.readdirSync(root);
		} catch {
			dates = [];
		}
		for (const date of dates) {
			const dateDir = path.join(root, date);
			let traces: string[] = [];
			try {
				traces = fs.readdirSync(dateDir);
			} catch {
				continue;
			}
			for (const trace of traces) {
				const dir = path.join(dateDir, trace);
				if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue;
				try {
					if (readManifest(dir).some((m) => m.thread_id && m.thread_id === threadId)) {
						dirs.add(dir);
					}
				} catch {
					/* skip unreadable manifest */
				}
			}
		}
	}

	let purged = 0;
	for (const dir of dirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			purged++;
		} catch (e) {
			console.error('purgeThreadArtifacts rm error:', dir, e);
		}
	}
	return purged;
}
