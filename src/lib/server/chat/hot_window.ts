import { type UIMessage } from 'ai';
import { getChatMessages } from '$lib/server/chat';

// ── Hot window ──────────────────────────────────────────────────────────────
// The frontend resets its SDK chat each send (streaming.svelte.ts), so
// `body.messages` carries only the CURRENT turn. The server is the single
// source of truth: assemble the model's real conversation from chat_messages
// here. Without this, switching models mid-thread (or any second turn) ships
// the new turn with NO history — the model genuinely "forgets" the chat.
// HOT_WINDOW must match working_memory.ts (the Layer-1 summary covers only
// older-than-window history; these last turns are sent verbatim).
const HOT_WINDOW = 20;

/**
 * Assemble the model's message history: HOT_WINDOW rows of durable chat_messages
 * history, pinned to this turn's own operator-row boundary, plus the body's own
 * turn (`messages`) appended verbatim.
 *
 * Concurrency scope (M6): two operator messages sent to the SAME thread ~1-2s
 * apart used to cross-contaminate — the later turn read the earlier, still
 * in-flight peer's freshly-persisted operator row into its window and answered
 * BOTH messages (the old `slice(0, len - messages.length)` only dropped a fixed
 * count from the end, so a peer's dangling operator row survived). Pin the
 * window to THIS turn's own operator row instead, keyed off its just-persisted
 * row id:
 *   1. Exclude any row a later peer persisted AFTER our snapshot (id >
 *      operatorRowId) — not part of this turn's history.
 *   2. Drop the TRAILING run of operator rows — our own just-persisted text copy
 *      PLUS any concurrent-peer operator row(s) that landed alongside it — then
 *      append the body's rich copy of our own turn instead (it preserves parts
 *      like image attachments that chat_messages stores only as text).
 * A settled (non-concurrent) thread ends in exactly ONE trailing operator row —
 * this turn's own — so single-send history is unchanged from before.
 */
export function buildHotWindow(
	threadId: string,
	operatorRowId: number,
	messages: UIMessage[]
): UIMessage[] {
	const windowRows = getChatMessages(HOT_WINDOW, threadId).filter(
		(r) =>
			r.sender !== 'system' &&
			typeof r.message === 'string' &&
			r.message.trim() !== '' &&
			r.id <= operatorRowId
	);
	let priorCut = windowRows.length;
	while (priorCut > 0 && windowRows[priorCut - 1].sender === 'operator') priorCut--;
	const priorTurns: UIMessage[] = windowRows.slice(0, priorCut).map(
		(r) =>
			({
				id: String(r.id),
				role: r.sender === 'operator' ? 'user' : 'assistant',
				parts: [{ type: 'text', text: r.message }]
			}) as UIMessage
	);
	return [...priorTurns, ...messages];
}
