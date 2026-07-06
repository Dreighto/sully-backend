import { readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import { serverConfig } from './config';
import type { ContentPart } from './llm_router';

export const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

export function extractImageUrls(body: string): string[] {
	const urls: string[] = [];
	let match;
	while ((match = MARKDOWN_IMAGE_RE.exec(body)) !== null) {
		urls.push(match[1]);
	}
	return urls;
}

export function stripMarkdownImages(body: string): string {
	let stripped = body.replace(MARKDOWN_IMAGE_RE, '');
	stripped = stripped.replace(/ +/g, ' ').replace(/ - /g, ' ').trim();
	return stripped;
}

export async function loadUploadAsContentPart(url: string): Promise<ContentPart | null> {
	if (!url.includes('/api/chat/uploads/')) return null;

	const filename = url.split('/').pop();
	if (!filename) return null;

	const filepath = path.join(serverConfig.chatUploadsDir, filename);
	if (!existsSync(filepath)) return null;

	const stat = statSync(filepath);
	if (stat.size > 5 * 1024 * 1024) {
		throw new Error(`Image size exceeds 5MB limit: ${filename}`);
	}

	const ext = path.extname(filename).toLowerCase();
	let mimeType = 'image/png';
	if (ext === '.jpeg' || ext === '.jpg') mimeType = 'image/jpeg';
	else if (ext === '.webp') mimeType = 'image/webp';
	else if (ext === '.gif') mimeType = 'image/gif';

	const buffer = readFileSync(filepath);
	const base64 = buffer.toString('base64');

	return { type: 'image', mimeType, base64 };
}

export async function buildMultimodalContent(body: string): Promise<string | ContentPart[]> {
	const urls = extractImageUrls(body);
	if (urls.length === 0) return body;

	if (urls.length > 20) {
		throw new Error('Maximum of 20 images allowed per request');
	}

	const parts: ContentPart[] = [];

	const strippedText = stripMarkdownImages(body);
	if (strippedText) {
		parts.push({ type: 'text', text: strippedText });
	}

	for (const url of urls) {
		const part = await loadUploadAsContentPart(url);
		if (part) {
			parts.push(part);
		}
	}

	if (parts.filter((p) => p.type === 'image').length === 0) {
		return body; // graceful fallback if no local files were found
	}

	return parts;
}
