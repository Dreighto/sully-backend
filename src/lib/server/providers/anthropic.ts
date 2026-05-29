// Anthropic provider — Claude Max subscription via MIRU_ROUTING_KEY.
// No fallback key: MIRU_ROUTING_KEY IS the subscription path.
// On 402 billing error, caller should rotate credential (not downgrade tier).

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

function roleMessageToAnthropic(msg: ProviderMessage) {
	if (typeof msg.content === 'string') {
		return { role: msg.role, content: msg.content };
	}
	return {
		role: msg.role,
		content: msg.content.map(part => {
			if (part.type === 'text') {
				return { type: 'text', text: part.text };
			}
			return {
				type: 'image',
				source: { type: 'base64', media_type: part.mimeType, data: part.base64 }
			};
		})
	};
}

export interface ProviderChatResult {
	reply: string;
	usage: { input: number; output: number; total: number };
}

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export function getApiKey(): string {
	return process.env.MIRU_ROUTING_KEY || process.env.ANTHROPIC_API_KEY || '';
}

export function isAvailable(): boolean {
	return !!getApiKey();
}

interface AnthropicResponse {
	content?: Array<{ type: string; text?: string }>;
	usage?: { input_tokens: number; output_tokens: number };
	error?: { type: string; message: string };
}

export async function chat(options: ProviderChatOptions): Promise<ProviderChatResult> {
	const key = getApiKey();
	if (!key) throw new Error('Anthropic: MIRU_ROUTING_KEY not configured');

	const resp = await fetch(`${ANTHROPIC_BASE}/messages`, {
		method: 'POST',
		headers: {
			'x-api-key': key,
			'anthropic-version': ANTHROPIC_VERSION,
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			model: options.model,
			max_tokens: 4096,
			messages: options.messages.map(roleMessageToAnthropic),
			...(options.system ? { system: options.system } : {})
		}),
		signal: options.signal
	});

	if (!resp.ok) {
		const body = await resp.text().catch(() => '');
		// Surface the status code so the router can distinguish 402 (billing)
		// from 5xx (outage). Do not wrap both under a generic Error.
		const err = new Error(`Anthropic HTTP ${resp.status}: ${body.slice(0, 300)}`);
		(err as Error & { status: number }).status = resp.status;
		throw err;
	}

	const data = (await resp.json()) as AnthropicResponse;
	if (data.error) throw new Error(`Anthropic API error: ${data.error.message}`);

	const reply = (data.content ?? [])
		.filter((p) => p.type === 'text')
		.map((p) => p.text ?? '')
		.join('')
		.trim();
	if (!reply) throw new Error('Anthropic returned an empty reply.');

	const input = data.usage?.input_tokens ?? 0;
	const output = data.usage?.output_tokens ?? 0;
	return { reply, usage: { input, output, total: input + output } };
}

export type StreamEvent =
	| { type: 'token'; text: string }
	| { type: 'done'; usage: { input: number; output: number; total: number } };

// Streaming chat — yields text deltas as they arrive from Anthropic's SSE
// transport, then a single 'done' event with usage totals. The caller is
// responsible for assembling the full reply string from the token events.
export async function* streamChat(options: ProviderChatOptions): AsyncGenerator<StreamEvent> {
	const key = getApiKey();
	if (!key) throw new Error('Anthropic: MIRU_ROUTING_KEY not configured');

	const resp = await fetch(`${ANTHROPIC_BASE}/messages`, {
		method: 'POST',
		headers: {
			'x-api-key': key,
			'anthropic-version': ANTHROPIC_VERSION,
			'content-type': 'application/json',
			accept: 'text/event-stream'
		},
		body: JSON.stringify({
			model: options.model,
			max_tokens: 4096,
			messages: options.messages.map(roleMessageToAnthropic),
			stream: true,
			...(options.system ? { system: options.system } : {})
		}),
		signal: options.signal
	});

	if (!resp.ok) {
		const body = await resp.text().catch(() => '');
		const err = new Error(`Anthropic HTTP ${resp.status}: ${body.slice(0, 300)}`);
		(err as Error & { status: number }).status = resp.status;
		throw err;
	}
	if (!resp.body) throw new Error('Anthropic: empty stream body');

	const reader = resp.body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buf = '';
	let inputTokens = 0;
	let outputTokens = 0;

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });

		// SSE events are separated by \n\n. Each event has `event: <name>` +
		// `data: <json>` lines. Pull complete events off the buffer.
		let sep: number;
		while ((sep = buf.indexOf('\n\n')) !== -1) {
			const raw = buf.slice(0, sep);
			buf = buf.slice(sep + 2);
			const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
			if (!dataLine) continue;
			const payload = dataLine.slice(6);
			if (!payload || payload === '[DONE]') continue;
			let evt: {
				type?: string;
				delta?: { type?: string; text?: string; output_tokens?: number };
				message?: { usage?: { input_tokens?: number; output_tokens?: number } };
				usage?: { input_tokens?: number; output_tokens?: number };
			};
			try {
				evt = JSON.parse(payload);
			} catch {
				continue;
			}
			if (
				evt.type === 'content_block_delta' &&
				evt.delta?.type === 'text_delta' &&
				evt.delta.text
			) {
				yield { type: 'token', text: evt.delta.text };
			} else if (evt.type === 'message_start' && evt.message?.usage) {
				inputTokens = evt.message.usage.input_tokens ?? inputTokens;
			} else if (evt.type === 'message_delta' && evt.usage) {
				outputTokens = evt.usage.output_tokens ?? outputTokens;
			}
		}
	}

	yield {
		type: 'done',
		usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens }
	};
}
