// Artifact listing + single-file serving for work-surface State C.
// Tailscale is the auth boundary — no app-level session gate on these routes.
//
// TODO(Sully-direct emission): when Sully posts inline artifacts from chat, workers
// should write to data/sully_artifacts/<thread_id>/<msg_id>/ and emit chat_activity
// rows pointing at those paths. Wire a sully-* trace prefix + thread-scoped bundle
// once Phase 5c lands — see project_artifact_output_system_required.md.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { serverConfig } from '$lib/server/config';
import { WORKER_TEMPLATES } from '$lib/work-surface/chatBridge.svelte';
import { findStoreDir, readManifest, artifactRepoRoot } from '$lib/server/artifactStore';

const FILE_ACTIONS = new Set(['wrote_file', 'created_artifact', 'write_file']);

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
}

export interface ArtifactListResponse {
	trace_id: string;
	task_id: string;
	artifacts: ArtifactMetadata[];
	count: number;
	bundle_url: string;
}

type JobRow = Record<string, unknown> & {
	trace_id: string;
	worker: string;
	ticket_id?: string | null;
	started_at?: string | null;
};

type ActivityRow = {
	action: string;
	target: string | null;
	timestamp: string | null;
};

const MIME: Record<string, string> = {
	md: 'text/markdown; charset=utf-8',
	html: 'text/html; charset=utf-8',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	svg: 'image/svg+xml',
	json: 'application/json',
	txt: 'text/plain; charset=utf-8',
	log: 'text/plain; charset=utf-8',
	diff: 'text/plain; charset=utf-8',
	patch: 'text/plain; charset=utf-8'
};

const ARTIFACT_TYPE: Record<string, string> = {
	md: 'doc',
	txt: 'doc',
	rst: 'doc',
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
	java: 'code',
	c: 'code',
	cpp: 'code',
	sh: 'code',
	json: 'data',
	yaml: 'data',
	yml: 'data',
	csv: 'data',
	toml: 'data',
	log: 'log',
	diff: 'log',
	patch: 'log'
};

const DEFAULT_WORKSPACE =
	process.env.LOGUEOS_ARTIFACT_WORKSPACE_DEFAULT ||
	'/home/dreighto/dev/worktrees/LogueOS-Companion/w1';

const APP_BASE = '/companion';

function workerShortCode(workerId: string): string {
	return WORKER_TEMPLATES[workerId]?.shortCode ?? workerId.slice(0, 8).toUpperCase();
}

export function classifyArtifactType(ext: string): string {
	return ARTIFACT_TYPE[ext.toLowerCase()] ?? 'other';
}

export function mimeFromExtension(ext: string): string {
	return MIME[ext.toLowerCase()] ?? 'application/octet-stream';
}

function openDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath, { readonly: true });
}

function getJob(traceId: string): JobRow | null {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return null;
	const db = openDb();
	try {
		return (
			(db.prepare('SELECT * FROM pending_jobs WHERE trace_id = ?').get(traceId) as JobRow) ?? null
		);
	} finally {
		db.close();
	}
}

function getActivity(traceId: string): ActivityRow[] {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = openDb();
	try {
		return db
			.prepare(
				`SELECT action, target, timestamp FROM chat_activity
				 WHERE trace_id = ? AND action IN ('wrote_file', 'created_artifact', 'write_file')
				 ORDER BY id ASC`
			)
			.all(traceId) as ActivityRow[];
	} finally {
		db.close();
	}
}

function resolveWorkspacePath(job: JobRow, activityRows: ActivityRow[]): string {
	const fromJob = (job.workspace_path ?? job.workspace_root) as string | undefined;
	if (fromJob && typeof fromJob === 'string' && fromJob.trim()) {
		return path.resolve(fromJob.trim());
	}

	const targets = activityRows.map((r) => r.target).filter(Boolean) as string[];
	if (targets.length === 0) return path.resolve(DEFAULT_WORKSPACE);

	const absolute = targets.filter((t) => path.isAbsolute(t));
	if (absolute.length === 0) return path.resolve(DEFAULT_WORKSPACE);

	let common = path.resolve(absolute[0]);
	for (const target of absolute.slice(1)) {
		const resolved = path.resolve(target);
		while (
			resolved !== common &&
			!resolved.startsWith(common + path.sep) &&
			common !== path.dirname(common)
		) {
			common = path.dirname(common);
		}
		if (!resolved.startsWith(common + path.sep) && resolved !== common) {
			common = path.dirname(resolved);
		}
	}
	return common;
}

function toOriginalPath(workspacePath: string, target: string): string {
	const normalized = target.replace(/\\/g, '/');
	if (path.isAbsolute(target)) {
		const rel = path.relative(workspacePath, path.resolve(target)).replace(/\\/g, '/');
		if (rel && !rel.startsWith('..')) return rel;
	}
	return normalized.replace(/^\/+/, '');
}

function artifactUrl(traceId: string, originalPath: string): string {
	const segments = originalPath.split('/').map((s) => encodeURIComponent(s));
	return `${APP_BASE}/api/artifacts/${encodeURIComponent(traceId)}/${segments.join('/')}`;
}

function fileTimestamp(row: ActivityRow, absolutePath: string): string {
	if (row.timestamp) {
		const ts = row.timestamp.trim();
		if (ts) {
			const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
			return iso.endsWith('Z') || /[+-]\d\d/.test(iso) ? iso : `${iso}Z`;
		}
	}
	try {
		return fs.statSync(absolutePath).mtime.toISOString();
	} catch {
		return new Date().toISOString();
	}
}

export function buildArtifactMetadata(
	job: JobRow,
	workspacePath: string,
	row: ActivityRow,
	originalPath: string
): ArtifactMetadata {
	const ext = originalPath.split('.').pop()?.toLowerCase() ?? '';
	return {
		created_by: workerShortCode(job.worker),
		task_id: (job.ticket_id as string | null) ?? job.trace_id,
		trace_id: job.trace_id,
		timestamp: fileTimestamp(row, path.resolve(workspacePath, originalPath)),
		source_worker: job.worker,
		workspace_path: workspacePath,
		artifact_type: classifyArtifactType(ext),
		original_path: originalPath,
		artifact_url: artifactUrl(job.trace_id, originalPath)
	};
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

/** Reject traversal segments and confine resolved path under workspace root. */
export function resolveArtifactFile(workspacePath: string, filepathParts: string[]): string {
	const joined = filepathParts.join('/');
	if (!joined || joined.includes('\0')) {
		throw Object.assign(new Error('invalid path'), { status: 404 });
	}
	const normalized = joined.replace(/\\/g, '/');
	if (normalized.includes('..') || path.isAbsolute(normalized)) {
		throw Object.assign(new Error('path traversal'), { status: 403 });
	}

	const root = path.resolve(workspacePath);
	const resolved = path.resolve(root, normalized);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		throw Object.assign(new Error('path escapes workspace'), { status: 403 });
	}
	return resolved;
}

/** Belt-and-suspenders: realpath must stay inside workspace (symlink escape defense). */
export function assertInsideWorkspace(workspacePath: string, targetPath: string): string {
	const root = fs.realpathSync(path.resolve(workspacePath));
	const real = fs.realpathSync(targetPath);
	if (real !== root && !real.startsWith(root + path.sep)) {
		throw Object.assign(new Error('symlink escape'), { status: 403 });
	}
	return real;
}

export function metadataHeaders(meta: ArtifactMetadata): Record<string, string> {
	return {
		'X-Artifact-Created-By': meta.created_by,
		'X-Artifact-Task-Id': meta.task_id,
		'X-Artifact-Trace-Id': meta.trace_id,
		'X-Artifact-Timestamp': meta.timestamp,
		'X-Artifact-Source-Worker': meta.source_worker,
		'X-Artifact-Workspace-Path': meta.workspace_path,
		'X-Artifact-Type': meta.artifact_type,
		'X-Artifact-Original-Path': meta.original_path,
		'X-Artifact-Url': meta.artifact_url
	};
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

	try {
		// Resolve path within the store directory
		const absolutePath = path.resolve(meta.workspace_path, meta.original_path);
		assertInsideWorkspace(meta.workspace_path, absolutePath);
		return { meta, absolutePath };
	} catch {
		return null;
	}
}

// ── Minimal ZIP (store-only, no compression) ────────────────────────────────

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()): { time: number; date: number } {
	return {
		time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff,
		date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
	};
}

export function buildZip(entries: { path: string; data: Buffer }[]): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;
	const { time, date } = dosDateTime();

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf8');
		const data = entry.data;
		const checksum = crc32(data);

		const local = Buffer.alloc(30 + nameBuf.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		nameBuf.copy(local, 30);
		localParts.push(local, data);

		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		nameBuf.copy(central, 46);
		centralParts.push(central);

		offset += local.length + data.length;
	}

	const centralDir = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDir.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);

	return Buffer.concat([...localParts, centralDir, end]);
}

export function buildBundleZip(traceId: string): Buffer | null {
	const listing = listArtifactsForTrace(traceId);
	if (!listing) return null;

	const zipEntries: { path: string; data: Buffer }[] = [
		{ path: 'manifest.json', data: Buffer.from(JSON.stringify(listing.artifacts, null, 2), 'utf8') }
	];

	for (const meta of listing.artifacts) {
		try {
			const absolutePath = path.resolve(meta.workspace_path, meta.original_path);
			assertInsideWorkspace(meta.workspace_path, absolutePath);
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
