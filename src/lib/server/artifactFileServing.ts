import fs from 'node:fs';
import path from 'node:path';
import type { ArtifactMetadata } from './artifactStore';

const MIME: Record<string, string> = {
	md: 'text/markdown; charset=utf-8',
	html: 'text/html; charset=utf-8',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	svg: 'image/svg+xml',
	webp: 'image/webp',
	json: 'application/json',
	txt: 'text/plain; charset=utf-8',
	log: 'text/plain; charset=utf-8',
	diff: 'text/plain; charset=utf-8',
	patch: 'text/plain; charset=utf-8'
};

const THUMBABLE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);

/** Lazily generate (and cache) a 240px webp thumbnail next to an image/svg
 *  artifact, returning its path. Generated on the first ?thumb=1 request; later
 *  requests serve the cached sibling. Returns null for non-thumbable types or on
 *  failure (the caller then falls back to serving the full file). sharp is
 *  dynamically imported so vite keeps it external (native libvips module). */
export async function ensureThumb(absolutePath: string, ext: string): Promise<string | null> {
	if (!THUMBABLE_EXT.has(ext.toLowerCase())) return null;
	const thumbPath = `${absolutePath}.thumb.webp`;
	if (fs.existsSync(thumbPath)) return thumbPath;
	try {
		const sharp = (await import('sharp')).default;
		await sharp(absolutePath)
			.resize(240, 240, { fit: 'inside', withoutEnlargement: true })
			.webp({ quality: 72 })
			.toFile(thumbPath);
		return fs.existsSync(thumbPath) ? thumbPath : null;
	} catch {
		return null;
	}
}

export function mimeFromExtension(ext: string): string {
	return MIME[ext.toLowerCase()] ?? 'application/octet-stream';
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
