// Phase 5b — confined artifact preview/download for Sully's workspace.
//
// GET /api/workspace/<project>/files/<...path>
//   default        → inline preview: raster images as image/*; EVERYTHING else
//                    (html, svg, md, code, json, txt) as text/plain so a
//                    worker-generated file can NEVER execute in the app origin
//                    (the "HTML as source, no live execution" v1 constraint).
//   ?download=1     → application/octet-stream + Content-Disposition: attachment.
//
// Auth: Tailscale is the boundary for the companion (no app-level cookie gate —
// same model as /api/chat/uploads). The load-bearing control here is path
// confinement: resolveWorkspaceFile() string-confines to <root>/<project>, then
// assertWorkspaceReal() realpath-checks the existing file (defeats symlinks).
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspaceFile, assertWorkspaceReal } from '$lib/server/workspace';

// Raster images are safe to render inline; SVG is NOT (it can carry script), so
// it falls through to the text/plain branch and is shown as source.
const IMAGE_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	heic: 'image/heic',
	heif: 'image/heif'
};

/** Strip anything that could break a Content-Disposition header. */
function safeFilename(name: string): string {
	return name.replace(/[^\w.\- ]/g, '_').slice(0, 200) || 'download';
}

export const GET: RequestHandler = async ({ params, url }) => {
	// 1. string-confine to <root>/<project> (rejects traversal/absolute/UNC/null)
	let resolved: string;
	try {
		resolved = resolveWorkspaceFile(params.project ?? '', params.path ?? '');
	} catch {
		return error(400, 'invalid path');
	}

	// 2. existence + must be a regular file
	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		return error(404, 'not found');
	}
	if (!stat.isFile()) return error(404, 'not a file');

	// 3. realpath-confine the EXISTING path (symlink escape defense)
	try {
		await assertWorkspaceReal(resolved);
	} catch {
		return error(403, 'forbidden');
	}

	const base = path.basename(resolved);
	const ext = base.split('.').pop()?.toLowerCase() ?? '';
	const buf = fs.readFileSync(resolved);
	const body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

	if (url.searchParams.get('download') === '1') {
		return new Response(body, {
			status: 200,
			headers: {
				'content-type': 'application/octet-stream',
				'content-length': String(stat.size),
				'content-disposition': `attachment; filename="${safeFilename(base)}"`,
				'x-content-type-options': 'nosniff',
				'cache-control': 'no-store'
			}
		});
	}

	// inline preview — raster image gets its real type; all else → text/plain
	// (never text/html / image/svg+xml, so untrusted markup can't execute).
	const isRaster = ext in IMAGE_MIME;
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': isRaster ? IMAGE_MIME[ext] : 'text/plain; charset=utf-8',
			'content-length': String(stat.size),
			'x-content-type-options': 'nosniff',
			'cache-control': 'no-store'
		}
	});
};
