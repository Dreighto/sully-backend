# Artifact Promotion & Durable Store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Every task must be read alongside the design spec: `docs/superpowers/specs/2026-06-08-artifact-promotion-design.md` — especially §2.5 download-integrity invariants, which are non-negotiable.**

**Goal:** Promote worker/Sully-produced deliverables into a durable, date-partitioned store with creator metadata at task completion, so the operator can open/download/share them from the phone and a tapped artifact never 404s after worktree cleanup.

**Architecture:** At task completion (`closeOutTask`), a creator-agnostic promotion pipeline selects deliverables (worker-declared `evidence.artifacts` primary + extension/name heuristic safety net over `evidence.fs_paths`), copies each into `data/sully/artifacts/<YYYY-MM-DD>/<trace_id>/`, and writes a per-trace `manifest.json` atomically. The manifest is the **sole** surfacing source: both `/api/artifacts/*` and the surface Result Files row read it; nothing reads worker paths. `created_artifact` activity rows are demoted to live-feed breadcrumbs emitted only after the manifest write.

**Tech Stack:** SvelteKit (Svelte 5 runes), better-sqlite3 (`companion.db` via `serverConfig.memoryDbPath`), Node `fs`/`path`, Vitest.

**Worker contract for paths:** the companion dispatches to the kernel listener, so the worker runs in a kernel-side worktree the companion cannot locate. Therefore **declared artifact paths MUST be absolute** (the worker knows its own cwd). Relative declared paths are best-effort resolved against the common root of `evidence.fs_paths` (mirrors existing `_artifactService.resolveWorkspacePath`).

---

## File Structure

- **Create** `src/lib/server/artifactStore.ts` — the durable store + manifest module (path layout, atomic manifest read/write, metadata builder, promotion selection). Single responsibility: own the store + manifest. ~200 lines.
- **Create** `tests/artifact-store.test.ts` — unit tests for selection, copy, atomic manifest, read.
- **Create** `tests/artifact-promotion-e2e.test.ts` — the §12 required 7-step persistence-guarantee E2E.
- **Modify** `src/lib/server/verifyPoll.ts` — extend `EvidenceEnvelope` with `artifacts?`.
- **Modify** `src/lib/server/completionClose.ts` — call the promotion pipeline in `closeOutTask`.
- **Modify** `src/lib/server/companionDispatch.ts` — add `evidence.artifacts` to the dispatch prompt's evidence contract.
- **Modify** `src/routes/api/artifacts/_artifactService.ts` — read the manifest instead of re-deriving from activity + live fs.
- **Modify** `src/lib/server/surfaceAdapter.ts` — `buildFiles` reads the manifest; add evidence list + promotion-warning to the surface payload.
- **Modify** `src/lib/work-surface/hybrid/hybrid-types.ts` — `SeedFile` gains `label`/`importance`; `SeedSurface` gains `evidence?` + `promotionWarning?`.
- **Modify** `src/lib/work-surface/hybrid/HybridDetailSheet.svelte` — Result Files ordered by importance + Evidence sub-section + warning.

---

## Task 1 — EvidenceEnvelope.artifacts + dispatch contract

**Files:**

- Modify: `src/lib/server/verifyPoll.ts:8-15` (EvidenceEnvelope)
- Modify: `src/lib/server/companionDispatch.ts` (the evidence line in the dispatch prompt, ~line 67)
- Test: `tests/artifact-store.test.ts` (type-shape test only here)

- [ ] **Step 1: Extend the evidence type.** In `verifyPoll.ts`, add to `EvidenceEnvelope`:

```ts
export interface DeclaredArtifact {
	/** ABSOLUTE path on the worker's machine (it knows its cwd). Relative is best-effort. */
	path: string;
	/** Human description shown to the operator. */
	label?: string;
	/** primary | secondary | supporting (default 'secondary'). */
	importance?: 'primary' | 'secondary' | 'supporting';
}
export interface EvidenceEnvelope {
	fs_paths?: string[] | null;
	artifacts?: DeclaredArtifact[] | null; // NEW — operator-facing deliverables
	git_ref?: string | null;
	repo?: string | null;
	pr_number?: number | null;
	health_url?: string | null;
}
```

- [ ] **Step 2: Update the dispatch prompt contract.** In `companionDispatch.ts` find the evidence JSON in the prompt (the `"evidence": { "fs_paths": [...] ... }` block) and add the `artifacts` field with guidance:

```
"evidence": { "fs_paths": ["<all files you created or edited>"], "artifacts": [{ "path": "<ABSOLUTE path to an operator-facing deliverable you produced — doc, mockup, screenshot, export, report; NOT source edits/temp/logs>", "label": "<short description>", "importance": "primary|secondary|supporting" }], "git_ref": "...", "repo": "...", "pr_number": null, "health_url": null }
```

Add one sentence above it: `Declare operator-facing DELIVERABLES in evidence.artifacts (absolute paths). Leave it empty if you only edited source.`

- [ ] **Step 3: Commit.**

```bash
git add src/lib/server/verifyPoll.ts src/lib/server/companionDispatch.ts
git commit -m "feat(artifacts): evidence.artifacts contract + dispatch prompt"
```

---

## Task 2 — artifactStore module: paths, selection, metadata, atomic manifest

**Files:**

- Create: `src/lib/server/artifactStore.ts`
- Test: `tests/artifact-store.test.ts`

Spec refs: §6 (store layout), §7 (metadata), §4 (selection), §2.5 (invariants).

- [ ] **Step 1: Write failing tests for selection.**

```ts
import { describe, it, expect } from 'vitest';
import { selectPromotions } from '$lib/server/artifactStore';

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
```

- [ ] **Step 2: Run — expect FAIL** (`selectPromotions` not defined). `npm test tests/artifact-store.test.ts`

- [ ] **Step 3: Implement selection.** In `artifactStore.ts`:

```ts
import type { DeclaredArtifact } from './verifyPoll';

const DELIVERABLE_EXT = new Set([
	'pdf',
	'md',
	'html',
	'svg',
	'png',
	'jpg',
	'jpeg',
	'webp',
	'csv',
	'zip'
]);
const DELIVERABLE_NAME = /(report|export|mockup|summary|deliverable)/i;
const EXCLUDE_DIR = /(^|\/)(\.git|node_modules)(\/|$)/;
const EXCLUDE_EXT = new Set(['log', 'tmp', 'lock', 'lockb']);
const SOURCE_EXT = new Set([
	'ts',
	'tsx',
	'js',
	'jsx',
	'svelte',
	'py',
	'go',
	'rs',
	'java',
	'c',
	'cpp',
	'h'
]);

function ext(p: string): string {
	return p.split('.').pop()?.toLowerCase() ?? '';
}
function basename(p: string): string {
	return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

export interface Promotion extends DeclaredArtifact {
	importance: 'primary' | 'secondary' | 'supporting';
}

export function selectPromotions(
	declared: DeclaredArtifact[],
	fsPaths: string[]
): { promoted: Promotion[] } {
	const seen = new Set<string>();
	const promoted: Promotion[] = [];
	// 1. declared = primary path; always promote, default importance 'secondary'
	for (const d of declared) {
		if (!d?.path || seen.has(d.path)) continue;
		seen.add(d.path);
		promoted.push({ ...d, importance: d.importance ?? 'secondary' });
	}
	// 2. heuristic safety net over fs_paths
	for (const p of fsPaths) {
		if (!p || seen.has(p)) continue;
		if (EXCLUDE_DIR.test(p) || EXCLUDE_EXT.has(ext(p))) continue;
		const isDeliverable = DELIVERABLE_EXT.has(ext(p)) || DELIVERABLE_NAME.test(basename(p));
		if (!isDeliverable) continue; // source/unknown stays evidence
		if (SOURCE_EXT.has(ext(p)) && !DELIVERABLE_NAME.test(basename(p))) continue;
		seen.add(p);
		promoted.push({ path: p, importance: 'supporting' });
	}
	return { promoted };
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Write failing tests for store paths + atomic manifest.**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	storeDirFor,
	writeManifestAtomic,
	readManifest,
	type ArtifactMetadata
} from '$lib/server/artifactStore';

it('storeDirFor is date-partitioned + trace-keyed', () => {
	const d = storeDirFor('/root', 'sully-123', '2026-06-08');
	expect(d).toBe(path.join('/root', 'data/sully/artifacts/2026-06-08/sully-123'));
});
it('writeManifestAtomic + readManifest round-trips and leaves no temp', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amf-'));
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
});
```

- [ ] **Step 6: Run — expect FAIL.**

- [ ] **Step 7: Implement store paths + metadata + atomic manifest.** Append to `artifactStore.ts`:

```ts
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
}

const ARTIFACT_TYPE: Record<string, string> = {
	md: 'doc',
	txt: 'doc',
	rst: 'doc',
	pdf: 'doc',
	html: 'mockup',
	svg: 'mockup',
	png: 'screenshot',
	jpg: 'screenshot',
	jpeg: 'screenshot',
	webp: 'screenshot',
	ts: 'code',
	js: 'code',
	svelte: 'code',
	py: 'code',
	go: 'code',
	rs: 'code',
	sh: 'code',
	json: 'data',
	yaml: 'data',
	yml: 'data',
	csv: 'data',
	toml: 'data',
	zip: 'data',
	log: 'log',
	diff: 'log',
	patch: 'log'
};
export function classifyArtifactType(e: string): string {
	return ARTIFACT_TYPE[e.toLowerCase()] ?? 'other';
}

export function storeRoot(repoRoot: string): string {
	return path.join(repoRoot, 'data/sully/artifacts');
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
```

- [ ] **Step 8: Run — expect PASS. Commit.**

```bash
git add src/lib/server/artifactStore.ts tests/artifact-store.test.ts
git commit -m "feat(artifacts): artifactStore — selection, store paths, atomic manifest, metadata"
```

---

## Task 3 — promotion pipeline (copy → manifest → breadcrumbs) wired into closeOutTask

**Files:**

- Modify: `src/lib/server/artifactStore.ts` (add `promoteArtifactsForTask`)
- Modify: `src/lib/server/completionClose.ts` (call it in `closeOutTask`)
- Test: `tests/artifact-store.test.ts`

Spec refs: §8 (pipeline ordering), §2.5.1/.4/.6 (copy-before-surface, atomic, failures stay evidence).

- [ ] **Step 1: Write failing test — promote copies, manifest written, failed stays out.**

```ts
import { promoteArtifactsForTask } from '$lib/server/artifactStore';
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
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `promoteArtifactsForTask`.** In `artifactStore.ts`:

```ts
export interface PromoteInput {
	repoRoot: string;
	traceId: string;
	date: string;
	job: { trace_id: string; worker: string; ticket_id?: string | null };
	evidence: { artifacts?: DeclaredArtifact[] | null; fs_paths?: string[] | null };
}
export interface PromoteResult {
	promoted: ArtifactMetadata[];
	failed: { path: string }[];
}

export function promoteArtifactsForTask(input: PromoteInput): PromoteResult {
	const { repoRoot, traceId, date, job } = input;
	const { promoted: candidates } = selectPromotions(
		input.evidence.artifacts ?? [],
		input.evidence.fs_paths ?? []
	);
	const dir = storeDirFor(repoRoot, traceId, date);
	const meta: ArtifactMetadata[] = [];
	const failed: { path: string }[] = [];
	for (const c of candidates) {
		try {
			const src = path.resolve(c.path);
			if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error('missing');
			const rel = basename(src); // flat copy; collisions get a numeric suffix below
			let dest = path.join(dir, rel);
			let n = 1;
			while (meta.some((m) => m.original_path === path.basename(dest)))
				dest = path.join(dir, `${n++}-${rel}`);
			fs.mkdirSync(dir, { recursive: true });
			fs.copyFileSync(src, dest);
			if (!fs.existsSync(dest)) throw new Error('copy_failed'); // verify (§2.5.1)
			const originalPath = path.basename(dest);
			meta.push({
				created_by: workerShort(job.worker),
				task_id: job.ticket_id ?? job.trace_id,
				trace_id: job.trace_id,
				timestamp: new Date().toISOString(),
				source_worker: job.worker,
				workspace_path: dir,
				artifact_type: classifyArtifactType(ext(originalPath)),
				original_path: originalPath,
				artifact_url: `/companion/api/artifacts/${encodeURIComponent(job.trace_id)}/${encodeURIComponent(originalPath)}`,
				label: c.label?.trim() || originalPath,
				importance: c.importance
			});
		} catch {
			failed.push({ path: c.path });
		}
	}
	if (meta.length) writeManifestAtomic(dir, sortByImportance(meta)); // atomic AFTER all copies (§2.5.4)
	return { promoted: meta, failed };
}
function workerShort(id: string): string {
	const m: Record<string, string> = {
		'claude-code': 'CC',
		gemini: 'GMI',
		agy: 'AGY',
		cdx: 'CDX',
		deepseek: 'DPSK',
		cursor: 'CUR'
	};
	return m[id] ?? id.slice(0, 3).toUpperCase();
}
const ORDER = { primary: 0, secondary: 1, supporting: 2 } as const;
function sortByImportance(m: ArtifactMetadata[]): ArtifactMetadata[] {
	return [...m].sort((a, b) => ORDER[a.importance] - ORDER[b.importance]);
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Wire into closeOutTask.** In `completionClose.ts`, inside `closeOutTask` after the result is captured (only when `outcome === 'done'`), call promotion + emit breadcrumbs/warning AFTER the manifest write:

```ts
import { promoteArtifactsForTask } from './artifactStore';
import path from 'node:path';
// ... inside closeOutTask, outcome === 'done' branch, job present:
try {
	const repoRoot = path.resolve(process.cwd()); // companion repo root
	const date = (job.started_at ?? new Date().toISOString()).slice(0, 10);
	const { promoted, failed } = promoteArtifactsForTask({
		repoRoot,
		traceId,
		date,
		job: { trace_id: traceId, worker: job.worker, ticket_id: job.ticket_id },
		evidence
	});
	for (const m of promoted) logTaskEvent(traceId, 'created_artifact', m.original_path); // breadcrumb AFTER manifest
	for (const f of failed) logTaskEvent(traceId, 'wrote_file', f.path); // stays evidence (§2.5.6)
} catch (e) {
	console.warn('[artifacts] promotion skipped:', e); // never breaks close-out
}
```

- [ ] **Step 6: Run full suite + build.** `npm test tests/artifact-store.test.ts && npm run check && npm run build` — expect 0 errors.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/server/artifactStore.ts src/lib/server/completionClose.ts tests/artifact-store.test.ts
git commit -m "feat(artifacts): promotion pipeline in closeOutTask (copy -> atomic manifest -> breadcrumbs)"
```

---

## Task 4 — read-side rewire to the manifest (the §2.5 surfacing guarantee)

**Files:**

- Modify: `src/routes/api/artifacts/_artifactService.ts`
- Modify: `src/lib/server/surfaceAdapter.ts` (`buildFiles` + return shape)
- Modify: `src/lib/work-surface/hybrid/hybrid-types.ts`
- Test: `tests/artifact-endpoints.test.ts` (extend), `tests/surface-adapter.test.ts` (extend)

Spec refs: §2.5.3/.5, §9.

- [ ] **Step 1: types.** In `hybrid-types.ts`, extend `SeedFile` with `label?: string; importance?: 'primary'|'secondary'|'supporting'`, and `SeedSurface` with `evidence?: { path: string }[]` and `promotionWarning?: string`.

- [ ] **Step 2: failing test — `_artifactService.listArtifactsForTrace` reads the manifest, not activity.**

```ts
it('lists artifacts from the durable manifest (not activity/live fs)', () => {
	// arrange: write a manifest under data/sully/artifacts/<date>/<trace>/manifest.json + the file
	// act: listArtifactsForTrace(trace)
	// assert: returns the manifest entries (11 fields incl. label/importance), count, bundle_url
});
```

- [ ] **Step 3: implement.** Replace the activity-derivation in `listArtifactsForTrace` with `findStoreDir(repoRoot, traceId)` + `readManifest(dir)`. Single-file handler resolves `path.join(dir, originalPath)` and rejects (404) anything not in the manifest or escaping `dir` (keep the existing path-traversal guard). `getTraceWorkspacePath` returns the store dir. bundle.zip zips the manifest files from the store dir + the manifest itself.

- [ ] **Step 4: failing test — `surfaceAdapter.buildFiles` reads the same manifest.**

```ts
it('buildFiles returns manifest artifacts as SeedFile[] with importance', async () => {
	/* manifest fixture → files[] match */
});
it('no manifest -> files: [] (no Result Files row)', async () => {
	/* trace w/o store -> [] */
});
```

- [ ] **Step 5: implement `buildFiles`.** Replace the `fs.existsSync(rawTarget)` logic: `const dir = findStoreDir(repoRoot, traceId); const man = dir ? readManifest(dir) : []; return man.map(m => ({ path: m.original_path, status: 'available', sizeBytes: statSafe(...), modifiedAt: m.timestamp, label: m.label, importance: m.importance }))`. Build `evidence` from the `wrote_file`/`write_file` activity targets. Set `promotionWarning` if there are `wrote_file` rows emitted by the failed-promotion path with a marker (or count). Order files by importance.

- [ ] **Step 6: run both test files + check + build.** Expect 0 errors, all pass.

- [ ] **Step 7: commit.**

```bash
git add src/routes/api/artifacts/_artifactService.ts src/lib/server/surfaceAdapter.ts src/lib/work-surface/hybrid/hybrid-types.ts tests/artifact-endpoints.test.ts tests/surface-adapter.test.ts
git commit -m "feat(artifacts): read-side reads the durable manifest (endpoints + surface), manifest is sole source"
```

---

## Task 5 — State C: Result Files (importance-ordered) + Evidence sub-section + warning

**Files:**

- Modify: `src/lib/work-surface/hybrid/HybridDetailSheet.svelte`
- Test: manual via Playwright iphone-webkit (documented in Task 6 E2E); add a component-render assertion if practical.

Spec refs: §9, §2.5.6.

- [ ] **Step 1:** In the Result Files section, render `surface.files` (already manifest-sourced + importance-ordered). Add a small importance chip (primary/secondary/supporting) and the `label` as the primary line, `original_path` as the secondary line. Keep the existing per-file Open/Share/Download/Copy-path actions + Download-all footer.

- [ ] **Step 2:** Add an **Evidence / work trace** collapsible sub-section listing `surface.evidence` paths as read-only text (clearly "not downloadable"). Only render if non-empty.

- [ ] **Step 3:** If `surface.promotionWarning`, render a non-blocking amber note above Result Files ("Some deliverables couldn't be saved — see work trace").

- [ ] **Step 4:** `npm run check && npm run build`; commit.

```bash
git add src/lib/work-surface/hybrid/HybridDetailSheet.svelte
git commit -m "feat(artifacts): State C result files (importance-ordered) + evidence sub-section + promotion warning"
```

---

## Task 6 — the §12 required persistence-guarantee E2E

**Files:**

- Create: `tests/artifact-promotion-e2e.test.ts`

Spec ref: §12 (the exact 7-step sequence is must-pass).

- [ ] **Step 1: Write the 7-step test.**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promoteArtifactsForTask, findStoreDir, readManifest } from '$lib/server/artifactStore';

it('artifact survives worktree deletion (persistence guarantee)', () => {
	const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')); // (1) worker worktree
	const file = path.join(worktree, 'mockup.html');
	fs.writeFileSync(file, '<h1>x</h1>'); // (1) worker creates file
	const evidence = {
		artifacts: [{ path: file, label: 'Mockup', importance: 'primary' as const }],
		fs_paths: [file]
	}; // (2) declared
	const { promoted } = promoteArtifactsForTask({
		// (3) closeOutTask promotes
		repoRoot,
		traceId: 'e2e',
		date: '2026-06-08',
		job: { trace_id: 'e2e', worker: 'gemini', ticket_id: null },
		evidence
	});
	const dir = findStoreDir(repoRoot, 'e2e')!;
	expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true); // (4) manifest written
	expect(readManifest(dir).map((m) => m.original_path)).toEqual(['mockup.html']); // (5) reads from manifest
	fs.rmSync(worktree, { recursive: true, force: true }); // (6) worktree deleted
	const served = fs.readFileSync(path.join(dir, promoted[0].original_path), 'utf8'); // (7) still opens
	expect(served).toBe('<h1>x</h1>'); // (7) no 404
});

it('a path not in the manifest is never served (no worker-path fallback)', () => {
	// arrange a store with manifest [a.md]; assert resolving b.md from the store is absent
});
```

- [ ] **Step 2: Run — expect PASS.** `npm test tests/artifact-promotion-e2e.test.ts`

- [ ] **Step 3: Full gates.** `npm run check && npm test && npm run build` — 0 errors, all green.

- [ ] **Step 4: Commit.**

```bash
git add tests/artifact-promotion-e2e.test.ts
git commit -m "test(artifacts): §12 persistence-guarantee E2E (survives worktree deletion)"
```

---

## Self-Review (author)

- **Spec coverage:** §2.5 invariants → Tasks 3 (copy-before-surface, atomic, failed-stays-evidence), 4 (manifest sole source, 404 not fallback), 6 (worktree-deletion test). §3 vocabulary → Task 3 breadcrumbs after manifest. §4 selection → Task 2. §5 contract → Task 1. §6 store → Task 2. §7 metadata → Task 2/3. §9 read rewire → Task 4. §12 tests → Task 6. Importance ordering → Task 3 (sort) + Task 5 (render). Promotion warning → Task 4/5. ✓
- **Placeholders:** Task 4/5 use prose-with-signatures rather than full literal code for the read rewire + Svelte render (the worker references the spec + existing `_artifactService`/`HybridDetailSheet` patterns). Acceptable for capable workers; the tricky logic (selection, atomic manifest, promotion, E2E) has complete code.
- **Type consistency:** `DeclaredArtifact`, `ArtifactMetadata`, `Promotion`, `PromoteResult`, `selectPromotions`, `promoteArtifactsForTask`, `storeDirFor`, `findStoreDir`, `readManifest`, `writeManifestAtomic` — names used consistently across tasks.

## Worker-loop notes

- **Each stage references this plan AND the spec** (`docs/superpowers/specs/2026-06-08-artifact-promotion-design.md`).
- **A verifier worker sanity-checks each stage** against the §2.5 invariants + runs the stage's gates (`npm run check`, the stage tests, `npm run build`).
- Tasks 2→3→4 are sequential (4 depends on the store module + manifest from 2/3). Task 1 is independent. Task 5 depends on Task 4 types. Task 6 depends on Task 3.
