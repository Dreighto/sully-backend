import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serverConfig } from './config';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_IMAGE_MODEL = process.env.LOGUEOS_GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

interface GeminiResponse {
	candidates?: {
		content?: { parts?: { text?: string; inlineData?: { data: string; mimeType: string } }[] };
		finishReason?: string;
	}[];
	error?: { message: string };
}

function ensureKey(): string {
	if (!GEMINI_API_KEY) {
		throw new Error('GEMINI_API_KEY is not set in environment');
	}
	return GEMINI_API_KEY;
}

/**
 * Generate an image via Gemini's image-generation model. Saves the
 * result PNG to the chat uploads dir and returns the public URL.
 */
export async function generateGeminiImage(prompt: string): Promise<{
	url: string;
	filename: string;
	mime: string;
	bytes: number;
}> {
	ensureKey();

	const body = {
		contents: [{ role: 'user', parts: [{ text: prompt }] }],
		generationConfig: {
			// Per Google docs: include both modalities so the model knows it
			// can return an image. Image-only output uses responseModalities
			// = ['IMAGE'] but mixing TEXT lets the model narrate what it
			// produced, which is occasionally useful.
			responseModalities: ['IMAGE', 'TEXT']
		}
	};

	const resp = await fetch(
		`${GEMINI_BASE_URL}/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}
	);

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Gemini image HTTP ${resp.status}: ${text.slice(0, 300)}`);
	}
	const data = (await resp.json()) as GeminiResponse;
	if (data.error) throw new Error(`Gemini image error: ${data.error.message}`);

	const cand = data.candidates?.[0];
	const parts = cand?.content?.parts || [];
	const imagePart = parts.find((p) => p.inlineData);
	if (!imagePart?.inlineData) {
		// 200 OK but no image. Usual causes: a content-policy refusal
		// (finishReason PROHIBITED_CONTENT / SAFETY / RECITATION — e.g. a
		// copyrighted character or restricted subject), or the model returned
		// text instead. Surface the REAL reason — a generic error here wrongly
		// sends the operator hunting the API key (it's almost never the key).
		const reason = cand?.finishReason;
		const text = parts
			.map((p) => p.text || '')
			.filter(Boolean)
			.join(' ')
			.trim();
		if (reason && reason !== 'STOP') {
			let hint = '';
			if (reason === 'PROHIBITED_CONTENT' || reason === 'RECITATION') {
				hint =
					' — usually a copyrighted character or restricted subject; try an original description instead';
			} else if (reason === 'SAFETY') {
				hint = ' — the prompt tripped a safety filter; try rephrasing';
			}
			throw new Error(
				`The image model declined this prompt [${reason}]${hint}.${text ? ` It said: "${text}"` : ''}`
			);
		}
		if (text) {
			throw new Error(`The model replied with text instead of an image: "${text}"`);
		}
		throw new Error(
			'The image model returned no image and no explanation — try rephrasing the prompt.'
		);
	}

	const mime = imagePart.inlineData.mimeType || 'image/png';
	const extMap: Record<string, string> = {
		'image/png': 'png',
		'image/jpeg': 'jpg',
		'image/webp': 'webp'
	};
	const rawBuffer = Buffer.from(imagePart.inlineData.data, 'base64');

	// Downsample for the inline chat surface. Gemini returns full-res images
	// (~2 MB PNG); that size stalls over cellular before iOS AsyncImage finishes
	// the transfer, so the reply renders "Image failed to load" even though the
	// file serves fine. A 1280px JPEG (~200-400 KB) loads reliably on a phone and
	// stays crisp inline (tap-through opens the same image). Fall back to the raw
	// bytes if sharp can't process this payload.
	let outBuffer: Buffer = rawBuffer;
	let outMime = mime;
	let outExt = extMap[mime] || 'png';
	try {
		// Dynamic import so vite leaves sharp (a native libvips module) external
		// instead of bundling it into the ESM chunk, where its CommonJS loader
		// breaks on __dirname. Same pattern the uploads route uses for heic-convert.
		const sharp = (await import('sharp')).default;
		outBuffer = await sharp(rawBuffer)
			.rotate()
			.resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
			.jpeg({ quality: 82 })
			.toBuffer();
		outMime = 'image/jpeg';
		outExt = 'jpg';
	} catch (e) {
		console.error('[gemini] image downsample failed, serving raw:', e);
	}

	const filename = `${crypto.randomUUID()}.${outExt}`;
	const fullPath = path.join(serverConfig.chatUploadsDir, filename);
	fs.mkdirSync(serverConfig.chatUploadsDir, { recursive: true });
	fs.writeFileSync(fullPath, outBuffer);

	return {
		url: `./api/chat/uploads/${filename}`,
		filename,
		mime: outMime,
		bytes: outBuffer.length
	};
}
