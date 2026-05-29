import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { serverConfig } from '$lib/server/config';

// heic-convert ships no types of its own. Minimal shape — accepts Buffer
// (or ArrayBuffer) and returns a Promise<Buffer> with the converted JPEG.
type HeicConvertFn = (opts: {
	buffer: ArrayBuffer | Uint8Array;
	format: 'JPEG' | 'PNG';
	quality?: number;
}) => Promise<Buffer>;

const HEIC_MIMES = new Set([
	'image/heic',
	'image/heif',
	'image/heic-sequence',
	'image/heif-sequence'
]);

// Accept these and only these. The Markdown renderer allows <img>; permitting
// non-image MIME types would let an operator paste arbitrary blobs which then
// render as broken images at best. Keep the list tight.
const ALLOWED_MIME = new Set([
	'image/png',
	'image/jpeg',
	'image/jpg',
	'image/gif',
	'image/webp',
	'image/svg+xml',
	// iPhone defaults — Safari uploads photos as HEIC/HEIF unless the user has
	// switched the Camera setting to "Most Compatible". Accept both so the
	// operator's phone uploads don't 415. Note: HEIC won't render inline in
	// non-Safari browsers; the markdown image link will show broken on
	// desktop until we add a transcode step.
	'image/heic',
	'image/heif',
	'image/heic-sequence',
	'image/heif-sequence'
]);

// 8 MB. iPhone screenshots are typically 1-3 MB; this leaves headroom for
// HEIC-converted-to-JPEG and full-res phone photos without becoming a DoS vector.
const MAX_BYTES = 8 * 1024 * 1024;

function extFromMime(mime: string): string {
	switch (mime) {
		case 'image/png':
			return 'png';
		case 'image/jpeg':
		case 'image/jpg':
			return 'jpg';
		case 'image/gif':
			return 'gif';
		case 'image/webp':
			return 'webp';
		case 'image/svg+xml':
			return 'svg';
		case 'image/heic':
		case 'image/heic-sequence':
			return 'heic';
		case 'image/heif':
		case 'image/heif-sequence':
			return 'heif';
		default:
			return 'bin';
	}
}

export const POST: RequestHandler = async ({ request }) => {
	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		return error(400, 'multipart/form-data expected');
	}

	const targetRepo = (formData.get('target_repo') as string | null)?.trim() ?? '';
	const file = formData.get('file');
	if (!(file instanceof File)) {
		return error(400, 'missing field: file');
	}

	if (!ALLOWED_MIME.has(file.type)) {
		return error(415, `unsupported media type: ${file.type}`);
	}
	if (file.size === 0) {
		return error(400, 'empty file');
	}
	if (file.size > MAX_BYTES) {
		return error(413, `file too large (max ${MAX_BYTES} bytes)`);
	}

	try {
		fs.mkdirSync(serverConfig.chatUploadsDir, { recursive: true });
	} catch (e) {
		console.error('chat-uploads mkdir failed:', e);
		return error(500, 'storage unavailable');
	}

	const id = crypto.randomUUID();
	let ext = extFromMime(file.type);
	let outputMime = file.type;
	let buffer: Buffer;
	try {
		buffer = Buffer.from(await file.arrayBuffer());
	} catch (e) {
		console.error('chat-uploads buffer read failed:', e);
		return error(500, 'read failed');
	}

	// HEIC/HEIF transcode → JPEG. iPhone photos default to HEIC which most
	// non-Safari browsers can't render inline. Transcode server-side and
	// store the JPEG so the chat renderer's markdown image link works
	// universally. Original HEIC bytes aren't persisted.
	if (HEIC_MIMES.has(file.type)) {
		try {
			const mod = await import('heic-convert');
			const heicConvert = (mod.default ?? mod) as HeicConvertFn;
			buffer = await heicConvert({ buffer, format: 'JPEG', quality: 0.85 });
			ext = 'jpg';
			outputMime = 'image/jpeg';
		} catch (e) {
			console.error('chat-uploads HEIC transcode failed:', e);
			return error(500, 'HEIC transcode failed');
		}
	}

	const filename = `${id}.${ext}`;
	const fullPath = path.join(serverConfig.chatUploadsDir, filename);

	try {
		fs.writeFileSync(fullPath, buffer);
	} catch (e) {
		console.error('chat-uploads write failed:', e);
		return error(500, 'write failed');
	}

	// Persist upload metadata (including target_repo) to the memory DB so we
	// can retrospectively trace which repo an image was uploaded for.
	try {
		const db = new Database(serverConfig.memoryDbPath);
		db.prepare(
			`CREATE TABLE IF NOT EXISTS chat_uploads (
				id TEXT PRIMARY KEY,
				filename TEXT NOT NULL,
				mime TEXT NOT NULL,
				size INTEGER NOT NULL,
				target_repo TEXT NOT NULL DEFAULT '',
				uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)`
		).run();
		db.prepare(
			'INSERT INTO chat_uploads (id, filename, mime, size, target_repo) VALUES (?, ?, ?, ?, ?)'
		).run(id, filename, outputMime, buffer.length, targetRepo);
		db.close();
	} catch (e) {
		// Non-fatal — file is already written; log and continue.
		console.warn('chat-uploads DB log failed:', e);
	}

	// Return a relative URL — the chat textarea inserts this verbatim as a
	// markdown image. Browser resolves it against the current path so
	// /console/chat + ./api/chat/uploads/X = /console/api/chat/uploads/X.
	return json({
		url: `./api/chat/uploads/${filename}`,
		filename,
		size: buffer.length,
		mime: outputMime,
		original_mime: file.type,
		transcoded: outputMime !== file.type,
		target_repo: targetRepo
	});
};
