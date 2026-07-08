import fs from 'node:fs';
import type { ChatMessage, InteractiveAction } from '$lib/types/chat';
import { serverConfig } from '../config';
import { getDb, parseRow } from './messages_read';

/**
 * Optional metadata bag threaded through addChatMessage. Mostly Phase 1 forensic
 * columns for an assistant turn (task_id links the row to its Task; the rest make
 * the turn auditable from the DB alone — turn_replay reads them directly). Also
 * carries the Stage 2 operator-turn idempotency key (clientTurnId) so a keyed
 * operator row can persist it. All optional + nullable, so the 30-odd positional
 * callers of addChatMessage need no change.
 */
export interface MessageForensics {
	taskId?: string | null;
	model?: string | null;
	provider?: string | null;
	promptTokens?: number | null;
	completionTokens?: number | null;
	latencyMs?: number | null;
	error?: string | null;
	/**
	 * Stage 2: client-supplied per-turn id. Persisted into chat_messages.client_turn_id
	 * so the same logical turn (retry/regenerate) can be keyed to one operator row.
	 * Null on every non-operator row and on untagged operator turns.
	 */
	clientTurnId?: string | null;
	// WI-7: assistant reasoning/thinking trace to persist alongside the reply.
	reasoning?: string | null;
}

/**
 * Defense-in-depth: a model reply can leak its machine-readable control block
 * (`<<<SULLY_GATE {...}>>>` dispatch directive, or an `<<<ESCALATE` variant) into
 * the operator-visible text. The reply-path strip only matches a well-formed,
 * CLOSED block, so a malformed one — e.g. the model copied the template and never
 * emitted the closing `>>>` — reached the operator as a garbage/blank reply and
 * never dispatched (operator 2026-07-08). Strip it here, robustly (closed AND
 * unclosed), at the single storage chokepoint so it can NEVER be shown regardless
 * of which reply path produced it.
 */
function stripLeakedControlBlocks(text: string): string {
	if (!text || (!text.includes('<<<SULLY_GATE') && !text.includes('<<<ESCALATE'))) return text;
	return text
		.replace(/<<<(SULLY_GATE|ESCALATE)\b[\s\S]*?>>>/g, '') // well-formed, closed
		.replace(/<<<(SULLY_GATE|ESCALATE)\b[\s\S]*$/g, '') // unclosed → strip to end
		.trim();
}

export function addChatMessage(
	sender: string,
	message: string,
	traceId: string | null = null,
	ticketId: string | null = null,
	interactiveAction: InteractiveAction | null = null,
	status = 'sent',
	threadId = 'default',
	forensics: MessageForensics = {}
): ChatMessage {
	// Never persist a leaked control block. If stripping empties an assistant
	// reply (the model emitted ONLY a botched gate), fall back to an honest
	// recovery line rather than a blank — but do NOT imply a dispatch happened.
	if (message.includes('<<<SULLY_GATE') || message.includes('<<<ESCALATE')) {
		const cleaned = stripLeakedControlBlocks(message);
		message =
			cleaned ||
			(sender === 'operator' ? message : 'Sorry — I garbled that one. Could you say it again?');
	}
	const db = getDb();
	try {
		const actionStr = interactiveAction ? JSON.stringify(interactiveAction) : null;
		const info = db
			.prepare(
				`INSERT INTO chat_messages
				 (sender, message, trace_id, ticket_id, interactive_action, status, thread_id,
				  task_id, model, provider, prompt_tokens, completion_tokens, latency_ms, error,
				  client_turn_id, reasoning)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				sender,
				message,
				traceId,
				ticketId,
				actionStr,
				status,
				threadId,
				forensics.taskId ?? null,
				forensics.model ?? null,
				forensics.provider ?? null,
				forensics.promptTokens ?? null,
				forensics.completionTokens ?? null,
				forensics.latencyMs ?? null,
				forensics.error ?? null,
				forensics.clientTurnId ?? null,
				forensics.reasoning ?? null
			);

		const insertedId = info.lastInsertRowid;
		const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(insertedId) as any;
		return parseRow(row);
	} catch (e: unknown) {
		console.error('addChatMessage error:', e);
		throw e;
	} finally {
		db.close();
	}
}

/**
 * Stage 2: fetch the single operator row for an idempotency key, or null. The
 * partial unique index idx_chat_client_turn guarantees at most one such row per
 * (thread_id, client_turn_id). Returns the parsed row PLUS its task_id (which
 * parseRow drops) so a reused turn can rebind to its original Task. Guarded
 * against a pre-migration DB (missing column / file) — returns null, letting the
 * caller fall through to the insert path.
 */
export function getOperatorTurnByClientId(
	threadId: string,
	clientTurnId: string
): { row: ChatMessage; taskId: string | null } | null {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return null;
	const db = getDb();
	try {
		const raw = db
			.prepare(
				`SELECT * FROM chat_messages
				 WHERE thread_id = ? AND client_turn_id = ? AND sender = 'operator'
				 ORDER BY id ASC LIMIT 1`
			)
			.get(threadId, clientTurnId) as any;
		if (!raw) return null;
		return { row: parseRow(raw), taskId: raw.task_id ?? null };
	} catch (e: unknown) {
		console.error('getOperatorTurnByClientId error:', e);
		return null;
	} finally {
		db.close();
	}
}

/**
 * Stage 2: race-safe INSERT of a keyed operator turn. INSERT ... ON CONFLICT DO
 * NOTHING against the partial unique index collapses a concurrent duplicate of
 * the SAME turn to one row. Returns the resulting row (ours if `inserted`, else
 * the concurrent/existing winner's re-SELECTed by key) + its task_id, and whether
 * THIS call performed the insert. Only operator rows go through here, so only the
 * columns an operator turn sets (task_id) are written; the rest default to NULL.
 */
export function insertOperatorTurnKeyed(opts: {
	sender: string;
	message: string;
	ticketId: string | null;
	threadId: string;
	clientTurnId: string;
	taskId: string | null;
}): { row: ChatMessage; taskId: string | null; inserted: boolean } {
	const db = getDb();
	try {
		const info = db
			.prepare(
				`INSERT INTO chat_messages
				 (sender, message, ticket_id, status, thread_id, task_id, client_turn_id)
				 VALUES (?, ?, ?, 'sent', ?, ?, ?)
				 ON CONFLICT DO NOTHING`
			)
			.run(opts.sender, opts.message, opts.ticketId, opts.threadId, opts.taskId, opts.clientTurnId);
		const inserted = info.changes > 0;
		const raw = (
			inserted
				? db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(info.lastInsertRowid)
				: db
						.prepare(
							`SELECT * FROM chat_messages
							 WHERE thread_id = ? AND client_turn_id = ? AND sender = 'operator'
							 ORDER BY id ASC LIMIT 1`
						)
						.get(opts.threadId, opts.clientTurnId)
		) as any;
		return { row: parseRow(raw), taskId: raw?.task_id ?? null, inserted };
	} catch (e: unknown) {
		console.error('insertOperatorTurnKeyed error:', e);
		throw e;
	} finally {
		db.close();
	}
}
