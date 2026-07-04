import type { DeclaredArtifact } from './verifyPoll';
import { workerLabel } from './worker-registry';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

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

// --- Thumbnail / preview helpers (artifact library tiles) --------------------
// Types whose first lines make a useful text tile in the library grid.
const PREVIEW_TYPES = new Set(['doc', 'code', 'data', 'plan', 'log']);
// Extensions that can produce a real raster thumbnail (served via ?thumb=1).
const THUMB_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);
const LANG_BY_EXT: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	py: 'python',
	go: 'go',
	rs: 'rust',
	java: 'java',
	c: 'c',
	cpp: 'cpp',
	h: 'c',
	sh: 'bash',
	svelte: 'svelte',
	css: 'css',
	scss: 'scss',
	html: 'html',
	json: 'json',
	yaml: 'yaml',
	yml: 'yaml',
	sql: 'sql',
	md: 'markdown',
	swift: 'swift',
	rb: 'ruby',
	php: 'php'
};

function previewFromText(content: string): string {
	return content.replace(/\r\n/g, '\n').slice(0, 400);
}
function previewFromFile(filePath: string): string | null {
	try {
		return previewFromText(fs.readFileSync(filePath).subarray(0, 4096).toString('utf8'));
	} catch {
		return null;
	}
}
function languageForExt(e: string): string | null {
	return LANG_BY_EXT[e.toLowerCase()] ?? null;
}
function thumbUrlFor(artifactUrl: string, e: string): string | null {
	return THUMB_EXT.has(e.toLowerCase()) ? `${artifactUrl}?thumb=1` : null;
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

export const ARTIFACT_TYPE: Record<string, string> = {
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
			const e = ext(originalPath);
			const aType = classifyArtifactType(e);
			const aUrl = `/companion/api/artifacts/${encodeURIComponent(job.trace_id)}/${encodeURIComponent(originalPath)}`;
			meta.push({
				created_by: workerShort(job.worker),
				task_id: job.ticket_id ?? job.trace_id,
				trace_id: job.trace_id,
				timestamp: new Date().toISOString(),
				source_worker: job.worker,
				workspace_path: dir,
				artifact_type: aType,
				original_path: originalPath,
				artifact_url: aUrl,
				label: c.label?.trim() || originalPath,
				importance: c.importance ?? 'secondary',
				thumb_url: thumbUrlFor(aUrl, e),
				preview_text: PREVIEW_TYPES.has(aType) ? previewFromFile(dest) : null,
				language: aType === 'code' ? languageForExt(e) : null,
				thread_id: null
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
			python: '.py',
			py: '.py',
			javascript: '.js',
			js: '.js',
			typescript: '.ts',
			ts: '.ts',
			swift: '.swift',
			bash: '.sh',
			sh: '.sh',
			json: '.json',
			yaml: '.yaml',
			yml: '.yml',
			html: '.html',
			css: '.css',
			sql: '.sql',
			markdown: '.md',
			md: '.md'
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
/** Mint a teacher artifact trace id. Exposed so the stream can pre-mint one,
 *  push it to the client mid-reply (data-sully-artifact), then promote the
 *  turn's artifacts under the SAME id so the live card resolves. */
export function mintTeacherTraceId(): string {
	const stamp = Date.now();
	const rand = randomBytes(4).toString('hex');
	return `sully-teacher-${stamp}-${rand}`;
}

export function promoteInlineArtifacts(
	inputs: InlineArtifactInput[],
	forcedTraceId?: string
): ArtifactMetadata[] {
	if (!inputs.length) return [];
	try {
		const repoRoot = artifactRepoRoot();
		const traceId = forcedTraceId ?? mintTeacherTraceId();
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
				importance: metas.length === 0 ? 'primary' : 'secondary',
				thumb_url: null,
				preview_text: previewFromText(input.content),
				language: input.artifactType === 'code' ? (input.language ?? null) : null,
				thread_id: input.threadId ?? null
			});
		}
		writeManifestAtomic(dir, metas);
		return metas;
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
