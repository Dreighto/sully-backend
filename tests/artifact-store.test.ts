import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	selectPromotions,
	storeDirFor,
	writeManifestAtomic,
	readManifest,
	type ArtifactMetadata
} from '$lib/server/artifactStore';

describe('selectPromotions', () => {
	it('promotes worker-declared artifacts (primary)', () => {
		const r = selectPromotions(
			[{ path: '/w/demo/index.html', label: 'Mockup', importance: 'primary' }],
			['/w/demo/index.html', '/w/src/app.ts']
		);
		expect(r.promoted.map((p) => p.path)).toEqual(['/w/demo/index.html']);
	});

	it('heuristic catches a missed deliverable in fs_paths', () => {
		const r = selectPromotions([], ['/w/report.pdf', '/w/src/x.ts', '/w/run.log']);
		expect(r.promoted.map((p) => p.path)).toEqual(['/w/report.pdf']);
	});

	it('excludes source edits, temp, logs even if undeclared', () => {
		const r = selectPromotions([], ['/w/src/a.ts', '/w/tmp/t.tmp', '/w/x.log', '/w/.git/c']);
		expect(r.promoted).toHaveLength(0);
	});

	it('declared wins even for a source extension (generated component)', () => {
		const r = selectPromotions(
			[{ path: '/w/src/Generated.svelte', label: 'New component' }],
			['/w/src/Generated.svelte']
		);
		expect(r.promoted).toHaveLength(1);
		expect(r.promoted[0].importance).toBe('secondary'); // default
	});
});

describe('artifact store paths and atomic manifest', () => {
	it('storeDirFor is date-partitioned + trace-keyed', () => {
		const d = storeDirFor('/root', 'sully-123', '2026-06-08');
		expect(d).toBe(path.join('/root', 'data/sully/artifacts/2026-06-08/sully-123'));
	});

	it('writeManifestAtomic + readManifest round-trips and leaves no temp', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amf-'));
		try {
			const meta: ArtifactMetadata[] = [
				{
					created_by: 'CC',
					task_id: 't',
					trace_id: 'tr',
					timestamp: 'now',
					source_worker: 'claude-code',
					workspace_path: dir,
					artifact_type: 'doc',
					original_path: 'a.md',
					artifact_url: '/x',
					label: 'A',
					importance: 'primary'
				}
			];
			writeManifestAtomic(dir, meta);
			expect(readManifest(dir)).toEqual(meta);
			expect(fs.readdirSync(dir).some((f) => f.includes('.tmp'))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('promotes declared file: copies to store, manifest has it; missing source is skipped not thrown', () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
		const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
		fs.writeFileSync(path.join(wt, 'report.md'), '# hi');
		const res = promoteArtifactsForTask({
			repoRoot,
			traceId: 'tr1',
			date: '2026-06-08',
			job: { trace_id: 'tr1', worker: 'claude-code', ticket_id: null },
			evidence: {
				artifacts: [
					{ path: path.join(wt, 'report.md'), label: 'Report', importance: 'primary' },
					{ path: path.join(wt, 'gone.md') }
				],
				fs_paths: []
			}
		});
		const dir = path.join(repoRoot, 'data/sully/artifacts/2026-06-08/tr1');
		expect(fs.existsSync(path.join(dir, 'report.md'))).toBe(true);
		const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
		expect(man.map((m: any) => m.original_path)).toEqual(['report.md']);
		expect(res.failed.map((f: any) => basename(f.path))).toEqual(['gone.md']);
		// Cleanup
		fs.rmSync(repoRoot, { recursive: true, force: true });
		fs.rmSync(wt, { recursive: true, force: true });
	});
});
