import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs';
import path from 'node:path';
import { serverConfig } from '$lib/server/config';

// Only this character set is valid for filenames written by POST /api/chat/uploads
// (UUID + . + 3-4 char extension). Anything else is either a traversal attempt
// or a stale link from a previous storage scheme — refuse early.
const FILENAME_RE = /^[a-f0-9-]{36}\.(png|jpe?g|gif|webp|svg|heic|heif)$/i;

const MIME_BY_EXT: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	heic: 'image/heic',
	heif: 'image/heif'
};

export const GET: RequestHandler = async ({ params }) => {
	const { filename } = params;
	if (!filename || !FILENAME_RE.test(filename)) {
		return error(400, 'invalid filename');
	}

	// Resolve + check the file actually lives under chatUploadsDir. Belt-and-
	// braces alongside the regex — the regex disallows `..` but path.resolve
	// catches any future regex weakness.
	const resolved = path.resolve(serverConfig.chatUploadsDir, filename);
	const root = path.resolve(serverConfig.chatUploadsDir);
	if (!resolved.startsWith(root + path.sep) && resolved !== root) {
		return error(400, 'invalid path');
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		return error(404, 'not found');
	}

	const ext = filename.split('.').pop()?.toLowerCase() || '';
	const mime = MIME_BY_EXT[ext] || 'application/octet-stream';

	const body = fs.readFileSync(resolved);
	const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	return new Response(arrayBuffer as ArrayBuffer, {
		status: 200,
		headers: {
			'content-type': mime,
			'content-length': String(stat.size),
			'cache-control': 'public, max-age=31536000, immutable',
			'x-content-type-options': 'nosniff'
		}
	});
};
