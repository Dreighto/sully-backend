import type { DeclaredArtifact } from './verifyPoll';
import { workerLabel } from './worker-registry';
import fs from 'node:fs';
import path from 'node:path';

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
	'h',
	'css',
	'scss',
	'less'
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
		if (basename(p).startsWith('.')) continue;
		if (SOURCE_EXT.has(ext(p))) continue;

		const isDeliverable = DELIVERABLE_EXT.has(ext(p)) || DELIVERABLE_NAME.test(basename(p));
		if (!isDeliverable) continue; // source/unknown stays evidence

		seen.add(p);
		promoted.push({ path: p, importance: 'supporting' });
	}
	return { promoted };
}

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
				importance: c.importance ?? 'secondary'
			});
		} catch {
			failed.push({ path: c.path });
		}
	}
	if (meta.length) writeManifestAtomic(dir, sortByImportance(meta)); // atomic AFTER all copies (§2.5.4)
	return { promoted: meta, failed };
}

// Labels flow from the worker registry (LOS-191) — no local snapshot.
// workerLabel already falls back to id.slice(0, 3).toUpperCase() for unknowns.
function workerShort(id: string): string {
	return workerLabel(id);
}

const ORDER = { primary: 0, secondary: 1, supporting: 2 } as const;
function sortByImportance(m: ArtifactMetadata[]): ArtifactMetadata[] {
	return [...m].sort((a, b) => ORDER[a.importance] - ORDER[b.importance]);
}

// ---------------------------------------------------------------------------
// Teacher-produced (inline) artifacts — Sully writes a plan/snippet/doc in chat
// via a <<<SULLY_ARTIFACT …>>> sentinel; we promote that INLINE CONTENT to the
// same durable store as worker files, so it shows in the library + cards with
// provenance source_worker="teacher". One pipeline, two producers (workers
// promote files; the teacher promotes inline content). MVP of the artifact-
// generation plan; versioning (same artifact_id → new version) is the next step.
// ---------------------------------------------------------------------------

function extForInlineType(artifactType: string, language?: string): string {
	if (language) {
		const l = language.toLowerCase();
		const map: Record<string, string> = {
			python: '.py', py: '.py', javascript: '.js', js: '.js', typescript: '.ts',
			ts: '.ts', swift: '.swift', bash: '.sh', sh: '.sh', json: '.json',
			yaml: '.yaml', yml: '.yml', html: '.html', css: '.css', sql: '.sql',
			markdown: '.md', md: '.md'
		};
		if (map[l]) return map[l];
	}
	switch (artifactType) {
		case 'code':
			return '.txt';
		case 'data':
			return '.json';
		case 'doc':
		case 'plan':
		default:
			return '.md';
	}
}

function slugifyTitle(title: string): string {
	const s = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return s || 'artifact';
}

export interface InlineArtifactInput {
	content: string;
	/** "doc" | "plan" | "code" | "data" */
	artifactType: string;
	title: string;
	language?: string;
	threadId?: string;
	taskId?: string;
}

/** Promote a BATCH of inline (teacher-written) artifacts from ONE reply turn to
 *  the durable store under ONE shared synthetic trace, so they group into a
 *  single inline card (and one bundle.zip). Returns all manifest metadata.
 *  Empty input → []. The whole batch fails closed to [] on any error. */
export function promoteInlineArtifacts(inputs: InlineArtifactInput[]): ArtifactMetadata[] {
	if (!inputs.length) return [];
	try {
		const repoRoot = artifactRepoRoot();
		const stamp = Date.now();
		const rand = Math.floor(stamp % 1_000_000).toString(16);
		const traceId = `sully-teacher-${stamp}-${rand}`;
		const date = new Date().toISOString().slice(0, 10);
		const dir = storeDirFor(repoRoot, traceId, date);
		fs.mkdirSync(dir, { recursive: true });
		const now = new Date().toISOString();
		const metas: ArtifactMetadata[] = [];
		const used = new Set<string>();
		for (const input of inputs) {
			const ext = extForInlineType(input.artifactType, input.language);
			const base = slugifyTitle(input.title);
			let filename = base + ext;
			let n = 1;
			while (used.has(filename)) filename = `${base}-${n++}${ext}`; // dedupe within the trace dir
			used.add(filename);
			fs.writeFileSync(path.join(dir, filename), input.content, 'utf8');
			metas.push({
				created_by: 'Sully',
				task_id: input.taskId ?? traceId,
				trace_id: traceId,
				timestamp: now,
				source_worker: 'teacher',
				workspace_path: dir,
				artifact_type: input.artifactType,
				original_path: filename,
				artifact_url: `/companion/api/artifacts/${encodeURIComponent(traceId)}/${encodeURIComponent(filename)}`,
				label: input.title.trim() || filename,
				importance: metas.length === 0 ? 'primary' : 'secondary'
			});
		}
		writeManifestAtomic(dir, metas);
		return metas;
	} catch {
		return [];
	}
}

/** Single-artifact convenience wrapper over promoteInlineArtifacts. */
export function promoteInlineArtifact(input: InlineArtifactInput): ArtifactMetadata | null {
	return promoteInlineArtifacts([input])[0] ?? null;
}
