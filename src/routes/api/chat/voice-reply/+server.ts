// Voice-turn reply stream. Takes the operator's (spoken→STT) text, persists it,
// and streams companion-v1-voice's reply back as PLAIN TEXT tokens (simple to
// render live + segment into sentences for per-sentence TTS — much easier to
// consume than the AI-SDK data-stream protocol). Persists the assistant reply
// when the stream completes. The companion persona lives in the model's own
// SYSTEM (Modelfile), so we just pass the recent conversation turns.
//
// Uses companion-v1-voice (8192 ctx) — the GPU-resident, full-speed voice model.
// request.signal is propagated to Ollama so a barge-in (client abort) stops
// generation server-side too.

import type { RequestHandler } from './$types';
import { addChatMessage, getChatMessages } from '$lib/server/chat';

const OLLAMA = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const VOICE_MODEL = process.env.COMPANION_VOICE_MODEL || 'companion-v1-voice:latest';
const HISTORY = 12; // recent turns of context (model SYSTEM carries the persona)

export const POST: RequestHandler = async ({ request }) => {
	let text = '';
	let threadId = 'default';
	try {
		const body = await request.json();
		text = (body.text || '').trim();
		threadId = body.thread || 'default';
	} catch {
		return new Response('invalid json', { status: 400 });
	}
	if (!text) return new Response('empty text', { status: 400 });

	// Persist the operator's spoken message first (so it's in the feed + history).
	addChatMessage('operator', text, null, null, null, 'sent', threadId);

	// Build the message list from recent thread history (drop system markers).
	const recent = getChatMessages(HISTORY, threadId) as Array<{ sender: string; message: string }>;
	const messages = recent
		.filter((m) => m.sender !== 'system')
		.map((m) => ({ role: m.sender === 'operator' ? 'user' : 'assistant', content: m.message }));
	// The history window can slide so it begins with an assistant turn — Ollama/the
	// model then returns an empty reply. Drop leading assistant turns so the array
	// always starts with a user message (the model's persona lives in its SYSTEM).
	while (messages.length && messages[0].role !== 'user') messages.shift();
	// Defensive: collapse consecutive same-role turns into one so the model always
	// sees clean user/assistant alternation. A run of consecutive user turns (e.g.
	// rapid sends, or malformed history) otherwise makes qwen's chat template emit
	// an empty reply.
	const turns: Array<{ role: string; content: string }> = [];
	for (const m of messages) {
		const last = turns[turns.length - 1];
		if (last && last.role === m.role) last.content += '\n' + m.content;
		else turns.push({ ...m });
	}

	let upstream: Response;
	try {
		upstream = await fetch(`${OLLAMA}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: VOICE_MODEL,
				messages: turns,
				stream: true,
				options: { num_ctx: 8192 }
			}),
			signal: request.signal
		});
	} catch {
		return new Response('voice model unreachable', { status: 502 });
	}
	if (!upstream.ok || !upstream.body) return new Response('voice model error', { status: 502 });

	let full = '';
	const enc = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const reader = upstream.body!.getReader();
			const dec = new TextDecoder();
			let buf = '';
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let nl: number;
					while ((nl = buf.indexOf('\n')) >= 0) {
						const line = buf.slice(0, nl).trim();
						buf = buf.slice(nl + 1);
						if (!line) continue;
						try {
							const tok = JSON.parse(line)?.message?.content || '';
							if (tok) {
								full += tok;
								controller.enqueue(enc.encode(tok));
							}
						} catch {
							/* skip non-JSON keepalive lines */
						}
					}
				}
			} catch {
				/* upstream aborted (barge-in) or dropped — fall through to persist what we have */
			} finally {
				reader.releaseLock();
				if (full.trim()) addChatMessage('local', full.trim(), null, null, null, 'sent', threadId);
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			}
		}
	});

	return new Response(stream, {
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
	});
};
