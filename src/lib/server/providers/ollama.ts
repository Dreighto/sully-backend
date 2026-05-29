// Ollama provider — local socket, no auth.
// Used for the 'local' tier (operator override only).

import type { ContentPart } from '../llm_router';

export interface ProviderMessage {
	role: 'user' | 'assistant';
	content: string | ContentPart[];
}

export interface ProviderChatOptions {
	messages: ProviderMessage[];
	model: string;
	system?: string;
	signal?: AbortSignal;
}

export interface ProviderChatResult {
	reply: string;
	usage: { input: number; output: number; total: number };
}

const OLLAMA_BASE =
	process.env.LOGUEOS_HERMES_OLLAMA_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

export function isAvailable(): boolean {
	return true; // Always true — offline fallback.
}

interface OllamaResponse {
	message?: { role: string; content: string };
	eval_count?: number;
	prompt_eval_count?: number;
	error?: string;
}

function roleMessageToOllama(msg: ProviderMessage) {
	if (typeof msg.content === 'string') {
		return { role: msg.role, content: msg.content };
	}
	const textParts = msg.content.filter(p => p.type === 'text').map(p => (p as {type:'text', text:string}).text).join('\n');
	const images = msg.content.filter(p => p.type === 'image').map(p => (p as {type:'image', base64:string}).base64);
	return {
		role: msg.role,
		content: textParts,
		...(images.length > 0 ? { images } : {})
	};
}

export async function chat(options: ProviderChatOptions): Promise<ProviderChatResult> {
	const resp = await fetch(`${OLLAMA_BASE.replace(/\/$/, '')}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: options.model,
			messages: options.system
				? [{ role: 'system', content: options.system }, ...options.messages.map(roleMessageToOllama)]
				: options.messages.map(roleMessageToOllama),
			stream: false,
			options: { num_predict: 4096, temperature: 0.7 }
		}),
		signal: options.signal
	});

	if (!resp.ok) {
		const body = await resp.text().catch(() => '');
		const err = new Error(`Ollama HTTP ${resp.status}: ${body.slice(0, 300)}`);
		(err as Error & { status: number }).status = resp.status;
		throw err;
	}

	const data = (await resp.json()) as OllamaResponse;
	if (data.error) throw new Error(`Ollama error: ${data.error}`);

	const reply = data.message?.content?.trim();
	if (!reply) throw new Error('Ollama returned an empty reply.');

	const input = data.prompt_eval_count ?? 0;
	const output = data.eval_count ?? 0;
	return { reply, usage: { input, output, total: input + output } };
}
