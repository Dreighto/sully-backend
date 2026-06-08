import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	promoteArtifactsForTask,
	findStoreDir,
	readManifest,
	storeDirFor,
	writeManifestAtomic,
	type ArtifactMetadata
} from '$lib/server/artifactStore';

// §12 persistence guarantee: a promoted deliverable is download-backed by the
// durable store, NOT path-backed by the worker's worktree. Deleting the worktree
// must never make a surfaced file disappear, and a path that was never promoted
// must never be served (no fallback to a raw worker path).
describe('artifact promotion — §12 persistence guarantee (E2E)', () => {
	it('artifact survives worktree deletion (the 7-step sequence)', () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
		const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')); // (1) worker worktree
		const file = path.join(worktree, 'mockup.html');
		fs.writeFileSync(file, '<h1>x</h1>'); // (1) worker creates the deliverable

		const evidence = {
			// (2) worker declares it in evidence.artifacts
			artifacts: [{ path: file, label: 'Mockup', importance: 'primary' as const }],
			fs_paths: [file]
		};

		const { promoted } = promoteArtifactsForTask({
			// (3) closeOutTask promotes (copy → atomic manifest)
			repoRoot,
			traceId: 'e2e',
			date: '2026-06-08',
			job: { trace_id: 'e2e', worker: 'gemini', ticket_id: null },
			evidence
		});
		expect(promoted).toHaveLength(1);

		const dir = findStoreDir(repoRoot, 'e2e')!;
		expect(dir).toBeTruthy();
		expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true); // (4) manifest written
		expect(readManifest(dir).map((m) => m.original_path)).toEqual(['mockup.html']); // (5) read from manifest

		fs.rmSync(worktree, { recursive: true, force: true }); // (6) worktree deleted
		expect(fs.existsSync(file)).toBe(false); // source is gone…

		const served = fs.readFileSync(path.join(dir, promoted[0]!.original_path), 'utf8'); // (7) still opens
		expect(served).toBe('<h1>x</h1>'); // (7) no 404 — durable copy survives

		fs.rmSync(repoRoot, { recursive: true, force: true });
	});

	it('a path not in the manifest is never served (no worker-path fallback)', () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
		const dir = storeDirFor(repoRoot, 'e2e2', '2026-06-08');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'a.md'), '# a');
		const meta: ArtifactMetadata[] = [
			{
				created_by: 'CC',
				task_id: 'e2e2',
				trace_id: 'e2e2',
				timestamp: '2026-06-08T00:00:00Z',
				source_worker: 'claude-code',
				workspace_path: dir,
				artifact_type: 'doc',
				original_path: 'a.md',
				artifact_url: '/companion/api/artifacts/e2e2/a.md',
				label: 'a.md',
				importance: 'primary'
			}
		];
		writeManifestAtomic(dir, meta);

		const manifest = readManifest(findStoreDir(repoRoot, 'e2e2')!);
		// Only the promoted file is in the manifest; b.md was never promoted…
		expect(manifest.map((m) => m.original_path)).toEqual(['a.md']);
		expect(manifest.some((m) => m.original_path === 'b.md')).toBe(false);
		// …and it is not in the durable store, so the endpoint has nothing to serve.
		expect(fs.existsSync(path.join(dir, 'b.md'))).toBe(false);

		fs.rmSync(repoRoot, { recursive: true, force: true });
	});
});
