// Layer 2 — Episodic memory: extract durable facts about Captain from a
// flagged thread and persist them (which embeds them for Layer 3 recall).
// Fired when the operator sets remember_flag on a thread.
//
// Uses the companion's own model (companion-v1 / qwen3) with thinking OFF for
// a clean fact list. Sender label fix: chat_messages.sender is
// 'operator' | 'local' | 'cc' | 'agy' — NOT 'user'/'assistant' — so 'operator'
// is Captain and everything else is Sully.

import { writeEpisodicFact } from './semantic';
import { serverConfig } from './config';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:11434';
const MODEL = serverConfig.companionDefaultModel || 'companion-v1:latest';

export async function extractAndStoreEpisodicFacts(
	threadId: string,
	messages: { sender: string; message: string; id?: number }[]
): Promise<number> {
	const transcript = messages
		.filter((m) => m.sender !== 'system')
		.slice(-12)
		.map((m) => `${m.sender === 'operator' ? 'Captain' : 'Sully'}: ${m.message}`)
		.join('\n');
	if (!transcript.trim()) return 0;

	const prompt = `Extract 3–5 concise facts about Captain (the user) from this conversation that are worth remembering across future sessions: preferences, goals, constraints, frustrations, key decisions. One fact per line. No preamble, no numbering, no quotes.

Conversation:
${transcript}`;

	let facts: string[] = [];
	try {
		const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: MODEL, prompt, stream: false, think: false })
		});
		if (!res.ok) throw new Error(`extract HTTP ${res.status}`);
		const data = (await res.json()) as { response?: string };
		facts = String(data.response || '')
			.split('\n')
			.map((l) => l.replace(/^[\s\-*•\d.)]+/, '').trim()) // strip bullets/numbering
			.filter((l) => l.length > 10)
			.slice(0, 6);
	} catch (e) {
		console.error('extractAndStoreEpisodicFacts: extraction failed:', e);
		return 0;
	}

	let stored = 0;
	for (const fact of facts) {
		try {
			await writeEpisodicFact(threadId, fact, undefined, 2);
			stored++;
		} catch (e) {
			console.error('writeEpisodicFact failed:', e);
		}
	}
	return stored;
}
