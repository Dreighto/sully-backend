// Layer 1 — Working memory: a rolling summary of the part of the thread that
// has scrolled out of the "hot window" (the last HOT_WINDOW messages sent
// verbatim). The summary is injected into the SYSTEM PROMPT by chat_prompt.ts
// (NOT as a mid-array system message — Anthropic/Gemini reject those).
//
// Refreshed in the background after assistant turns (fire-and-forget from
// chat_turn.persistAssistantTurn) once a thread grows past SUMMARY_FLOOR.

import { getChatMessageCount, getMessagesBeforeRecent } from './chat';
import { setSummary } from './thread_meta';
import { serverConfig } from './config';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:11434';
const MODEL = serverConfig.companionDefaultModel || 'companion-v1:latest';

const HOT_WINDOW = 20; // messages sent verbatim (must match the route's window)
const SUMMARY_FLOOR = 30; // don't summarize until a thread exceeds this
const SUMMARY_EVERY = 10; // re-summarize every N messages thereafter

export async function maybeUpdateThreadSummary(threadId: string): Promise<void> {
	const count = getChatMessageCount(threadId);
	if (count < SUMMARY_FLOOR || count % SUMMARY_EVERY !== 0) return;

	const older = getMessagesBeforeRecent(HOT_WINDOW, threadId).filter((m) => m.sender !== 'system');
	if (older.length < 5) return;

	const transcript = older
		.map((m) => `${m.sender === 'operator' ? 'Captain' : 'Sully'}: ${m.message}`)
		.join('\n');

	try {
		const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: MODEL,
				prompt: `Summarize this earlier part of a conversation between Captain and Sully in 3–5 short bullet points — key facts, decisions, and open threads. Plain English, no preamble.\n\n${transcript}`,
				stream: false,
				think: false
			})
		});
		if (!res.ok) return;
		const data = (await res.json()) as { response?: string };
		const summary = String(data.response || '').trim();
		if (summary) setSummary(threadId, summary);
	} catch (e) {
		console.error('maybeUpdateThreadSummary failed:', e);
	}
}
