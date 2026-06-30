import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadOperatorProfile } from './hermes';
import { serverConfig } from './config';

// Direct Gemini API integration — bypasses the gateway + dispatch_listener
// for chat-style AGY interactions. Worker dispatch (the heavy CC/AGY
// spawn with file access) still lives behind the action buttons; the AGY
// pill on the chat page now means "talk to Gemini directly" instead of
// "spin up a worker".
//
// Same architectural pattern as src/lib/server/hermes.ts but pointed at
// Google's Generative Language API instead of local Ollama.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
// Chat-mode default = flash-lite (cheapest + fastest Gemini variant).
// Operator chose this explicitly: chat-style brainstorming should burn
// near-zero tokens; heavy reasoning escalates via the Build / Critique /
// Verify action buttons which dispatch the full worker (different
// billing path). Override via LOGUEOS_GEMINI_CHAT_MODEL if a specific
// conversation genuinely needs flash or pro.
//
// Approximate pricing (per 1M tokens, Google AI Studio, 2026):
//   flash-lite  $0.10 in / $0.40 out  ← current default
//   flash       $0.30 in / $2.50 out
//   pro         $1.25 in / $10.00 out
const GEMINI_CHAT_MODEL = process.env.LOGUEOS_GEMINI_CHAT_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_IMAGE_MODEL = process.env.LOGUEOS_GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

export interface GeminiTurn {
	role: 'user' | 'model';
	content: string;
}

interface GeminiContent {
	role: 'user' | 'model';
	parts: { text: string }[];
}

interface GeminiResponse {
	candidates?: {
		content?: { parts?: { text?: string; inlineData?: { data: string; mimeType: string } }[] };
		finishReason?: string;
	}[];
	error?: { message: string };
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		totalTokenCount?: number;
	};
}

function ensureKey(): string {
	if (!GEMINI_API_KEY) {
		throw new Error('GEMINI_API_KEY is not set in environment');
	}
	return GEMINI_API_KEY;
}

/**
 * Build the AGY chat system prompt — Antigravity-specific role wrapper +
 * operator profile. Mirrors the hermes.buildHermesSystemPrompt shape but
 * positions AGY as a brainstorm/architect partner rather than a sounding
 * board.
 */
function buildAgyChatSystemPrompt(): string {
	const profile = loadOperatorProfile();
	return `You are AGY (Antigravity) — Gemini-class model talking to the Captain via the LogueOS Console chat tab. You're being called via the Google Gemini API directly (no worker spawn, no file access, no MCP tools). This is the CHAT-MODE persona: a fast, conversational brainstorm partner.

Your role in this mode is BRAINSTORM / ARCHITECT, not implementer. Key constraints:

- You have NO file-system access in this mode. No git, no shell, no MCP tools. You cannot read files, run commands, or modify the codebase.
- You are FAST (~1-3s). Keep replies concise and conversational unless the Captain asks for depth.
- You do not fabricate ticket IDs, commit hashes, PR numbers, or file paths you can't verify.
- When the Captain wants to ACT on an idea you discussed — tap into the file system, edit code, run tests, commit, push — point him at the "Build" or "Critique" action buttons on your reply, which dispatch the full AGY worker (with file access) on whatever you just discussed. Or he can switch to CC and say "build this".

You DO know:
- The operator profile below — how the Captain communicates, his preferences, working modes.
- LogueOS architecture (orchestrator kernel + Console + project-miru payload, dispatch loop, MCP gateway, multi-agent team).
- Your own role and limits in this mode.

Team:
- CC (Claude Code) — primary backend worker, file/code/system access, runs via Anthropic OAuth.
- AGY (you, when dispatched as worker) — full Antigravity CLI worker, file access, used for frontend + parallel work.
- Hermes — local Qwen sounding board, even faster than you, no API cost.
- The Captain (dreighto) — directs everyone.

When you reply, lead with the answer or the recommendation, NOT a restatement of his question.

---

${profile}

---

End of operator profile. Remember: you are AGY in CHAT MODE. Fast, conversational, brainstorming partner. When the operator wants to actually DO something, point at the action buttons. They escalate the conversation into a real worker dispatch.`;
}

/**
 * Chat with Gemini directly. Returns the assistant text + token usage.
 */
export async function callGeminiChat(
	history: GeminiTurn[],
	userMessage: string
): Promise<{ reply: string; usage: { input: number; output: number; total: number } }> {
	ensureKey();

	const contents: GeminiContent[] = [
		...history.map((t) => ({ role: t.role, parts: [{ text: t.content }] })),
		{ role: 'user', parts: [{ text: userMessage }] }
	];

	const body = {
		systemInstruction: { parts: [{ text: buildAgyChatSystemPrompt() }] },
		contents,
		generationConfig: {
			temperature: 0.7,
			maxOutputTokens: 2048
		}
	};

	const resp = await fetch(
		`${GEMINI_BASE_URL}/models/${GEMINI_CHAT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}
	);

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Gemini HTTP ${resp.status}: ${text.slice(0, 300)}`);
	}
	const data = (await resp.json()) as GeminiResponse;
	if (data.error) throw new Error(`Gemini error: ${data.error.message}`);

	const parts = data.candidates?.[0]?.content?.parts || [];
	const reply = parts
		.map((p) => p.text || '')
		.filter(Boolean)
		.join('\n')
		.trim();
	if (!reply) throw new Error('Gemini returned an empty reply.');

	const u = data.usageMetadata || {};
	return {
		reply,
		usage: {
			input: u.promptTokenCount || 0,
			output: u.candidatesTokenCount || 0,
			total: u.totalTokenCount || 0
		}
	};
}

/**
 * Convert chat_messages rows into Gemini turn format. Same filtering as
 * the Hermes path — drop dispatch announcements, reset markers, system
 * symbols. Last N turns only.
 */
export function chatRowsToGeminiHistory(rows: { sender: string; message: string }[]): GeminiTurn[] {
	const turns: GeminiTurn[] = [];
	for (const r of rows) {
		if (r.sender === 'system') {
			if (
				r.message.startsWith('Agent dispatched:') ||
				r.message.startsWith('--- NEW CONVERSATION') ||
				r.message.startsWith('💬') ||
				r.message.startsWith('⚠️') ||
				r.message.startsWith('🔍') ||
				r.message.startsWith('🔨') ||
				r.message.startsWith('🧪') ||
				r.message.startsWith('↻')
			) {
				continue;
			}
		}
		if (r.sender === 'operator') {
			turns.push({ role: 'user', content: r.message });
		} else {
			// Gemini doesn't distinguish between assistant senders — collapse
			// CC/AGY/Hermes/system replies into "model" role.
			const tag = r.sender !== 'agy' && r.sender !== 'model' ? `[${r.sender}]: ` : '';
			turns.push({ role: 'model', content: `${tag}${r.message}` });
		}
	}
	return turns.slice(-20);
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

export function isGeminiAvailable(): boolean {
	return !!GEMINI_API_KEY;
}
