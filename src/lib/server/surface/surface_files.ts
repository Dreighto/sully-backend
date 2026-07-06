import fs from 'node:fs';
import path from 'node:path';
import { findStoreDir, readManifest, artifactRepoRoot } from '$lib/server/artifactStore';
import type { SeedFile } from '$lib/work-surface/hybrid/hybrid-types';

export async function buildFiles(activityRows: any[]): Promise<SeedFile[]> {
	const repoRoot = artifactRepoRoot();
	const traceId = activityRows[0]?.trace_id;
	if (!traceId) return [];

	const storeDir = findStoreDir(repoRoot, traceId);
	if (!storeDir) return [];

	const manifest = readManifest(storeDir);
	const files: SeedFile[] = [];

	for (const meta of manifest) {
		try {
			const absolutePath = path.resolve(storeDir, meta.original_path);
			const stat = fs.statSync(absolutePath);
			files.push({
				path: meta.original_path,
				status: 'available',
				sizeBytes: stat.size,
				modifiedAt: stat.mtime.toISOString(),
				label: meta.label,
				importance: meta.importance
			});
		} catch {
			files.push({
				path: meta.original_path,
				status: 'failed',
				sizeBytes: 0,
				modifiedAt: null,
				label: meta.label,
				importance: meta.importance
			});
		}
	}

	// Sort by importance: primary → secondary → supporting
	const order = { primary: 0, secondary: 1, supporting: 2 };
	files.sort((a, b) => order[a.importance ?? 'secondary'] - order[b.importance ?? 'secondary']);

	return files;
}
