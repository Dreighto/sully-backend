import fs from 'node:fs';
import path from 'node:path';

// Hermes runs locally via Ollama. The chat UI's Hermes pill routes here
// instead of going through the gateway / dispatch_listener — no worker
// spawn, no MCP cold start, no token billing. Just a direct fetch to the
// local Ollama daemon.
//
// Model defaults to qwen2.5:7b (fast, runs on the iGPU). Operator can
// override via LOGUEOS_HERMES_MODEL if they want to swap to qwen2.5:14b
// or another local model.

const OLLAMA_URL =
	process.env.LOGUEOS_HERMES_OLLAMA_URL ||
	process.env.OLLAMA_BASE_URL ||
	'http://127.0.0.1:11434';
const HERMES_MODEL = process.env.LOGUEOS_HERMES_MODEL || 'qwen2.5:7b';

const OPERATOR_PROFILE_PATH =
	process.env.LOGUEOS_OPERATOR_PROFILE_PATH ||
	'/home/dreighto/dev/LogueOS-Orchestrator/.logueos/context/operator-profile.md';

// Read-once cache. If the operator updates the profile while the Console
// is running, restart the service to pick it up. Cheap to flush — we
// just clear the cache and re-read next call.
let cachedProfile: string | null = null;

export function loadOperatorProfile(): string {
	if (cachedProfile !== null) return cachedProfile;
	try {
		cachedProfile = fs.readFileSync(OPERATOR_PROFILE_PATH, 'utf-8');
	} catch (e) {
		console.error('hermes: failed to read operator profile:', e);
		cachedProfile = '';
	}
	return cachedProfile;
}

export function flushOperatorProfileCache(): void {
	cachedProfile = null;
}

export interface HermesTurn {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

/**
 * Build the system message for Hermes — Hermes-specific role wrapper +
 * the full operator profile. The profile was written for Claude Chat but
 * everything in it (style, tone, working modes, signal-detection) applies
 * to any conversational agent talking to the Captain.
 */
export function buildHermesSystemPrompt(): string {
	const profile = loadOperatorProfile();
	return `You are Hermes — a local Qwen-class model running on the operator's home machine via Ollama. You're part of the Captain's LogueOS team alongside CC (Claude Code), AGY (Antigravity / Gemini), and CH (Claude Chat).

Your role is CONVERSATIONAL SOUNDING BOARD, not implementer. Key constraints:

- You have NO file-system access. No git, no shell, no MCP tools. You cannot read files, run commands, or modify the codebase. If the Captain asks for code work, suggest dispatching to CC or AGY.
- You are LOCAL and FAST. Operator pays nothing per call. Responses should be ~1-3 seconds. Keep them concise.
- You do not fabricate ticket IDs, commit hashes, PR numbers, or file paths you can't verify. If you don't know, say so.
- If the Captain asks something you genuinely don't know about the current state of the system (live service status, recent commits, what's in a file), say "I'd ask CC for that — it has file access and I don't." Then offer to draft the question.

You DO know:
- The operator profile below — how the Captain communicates, his working modes, his preferences.
- General context about LogueOS architecture (kernel + Console + project-miru payload, dispatch loop, MCP gateway, multi-agent team).
- Your own role and limits.

The rest of this system prompt is the operator profile — read it carefully. Every guideline in it applies to you. Especially: plain English first, no sycophancy, brief replies are green lights (not requests for elaboration), no pause-framed narration, don't comment on his work schedule.

---

${profile}

---

End of operator profile. Remember: you are HERMES — a fast, local, conversational partner. You don't write code, you don't execute commands. You help the Captain think, you keep context, you suggest dispatches when implementation is needed.`;
}

interface OllamaMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

interface OllamaResponse {
	message?: { role: string; content: string };
	error?: string;
}

/**
 * Call Hermes (local Ollama) with a conversation history. Returns the
 * assistant's reply text, or throws on error.
 */
export async function callHermes(history: HermesTurn[], userMessage: string): Promise<string> {
	const messages: OllamaMessage[] = [
		{ role: 'system', content: buildHermesSystemPrompt() },
		// History up to the current turn.
		...history,
		{ role: 'user', content: userMessage }
	];

	const resp = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: HERMES_MODEL,
			messages,
			stream: false,
			options: {
				// Keep the conversation snappy. Long-tail outputs from a 7B
				// model rarely add value past ~600 tokens for chat-style
				// replies.
				num_predict: 800,
				temperature: 0.7
			}
		})
	});

	if (!resp.ok) {
		const body = await resp.text();
		throw new Error(`Hermes HTTP ${resp.status}: ${body.slice(0, 200)}`);
	}
	const data = (await resp.json()) as OllamaResponse;
	if (data.error) throw new Error(`Hermes error: ${data.error}`);
	const reply = data.message?.content;
	if (!reply || !reply.trim()) {
		throw new Error('Hermes returned an empty reply.');
	}
	return reply.trim();
}

/**
 * Convert chat_messages rows into Hermes turn format. Operator → 'user',
 * cc/agy/hermes/system → 'assistant' (with a small sender prefix so
 * Hermes can tell who said what). Filters reset markers and dispatch
 * announcements that would just add noise to the local model's context.
 */
export function chatRowsToHermesHistory(
	rows: { sender: string; message: string }[]
): HermesTurn[] {
	const turns: HermesTurn[] = [];
	for (const r of rows) {
		if (r.sender === 'system') {
			// Skip dispatch announcements + reset markers — Hermes doesn't
			// need to know about CC/AGY routing internals.
			if (
				r.message.startsWith('Agent dispatched:') ||
				r.message.startsWith('--- NEW CONVERSATION') ||
				r.message.startsWith('💬 No agent') ||
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
			const tag = r.sender === 'hermes' ? '' : `[${r.sender}]: `;
			turns.push({ role: 'assistant', content: `${tag}${r.message}` });
		}
	}
	// Hermes context windows are small (Qwen 7B is 32k tokens but we keep
	// it tight for speed). Trim to the last 20 turns — anything older is
	// rarely relevant to the immediate reply.
	return turns.slice(-20);
}
