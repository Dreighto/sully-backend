import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from '../config';
import type { ChatMessage, InteractiveAction } from '$lib/types/chat';
import { ensureActionRisk } from '$lib/server/chat/action_risk';

export function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

export function parseRow(row: any): ChatMessage {
	let interactive_action: InteractiveAction | null = null;
	if (row.interactive_action) {
		try {
			interactive_action = ensureActionRisk(JSON.parse(row.interactive_action));
		} catch {
			interactive_action = null;
		}
	}
	return {
		id: row.id,
		sender: row.sender,
		message: row.message,
		trace_id: row.trace_id || null,
		ticket_id: row.ticket_id || null,
		interactive_action,
		status: row.status,
		timestamp: row.timestamp,
		thread_id: row.thread_id || 'default',
		quality_signal:
			row.quality_signal === null || row.quality_signal === undefined
				? null
				: Number(row.quality_signal),
		client_turn_id: row.client_turn_id ?? null,
		reasoning: row.reasoning ?? null
	};
}

export function getChatMessages(limit = 100, threadId = 'default'): ChatMessage[] {
	if (!fs.existsSync(serverConfig.memoryDbPath)) {
		return [];
	}

	const db = getDb();
	try {
		// Return the MOST RECENT `limit` messages in ascending (insertion) order.
		// Ordering by `id` (monotonic PK) — NOT `timestamp`, which is second-resolution
		// and ties (two messages in the same second order arbitrarily, scrambling the
		// user/assistant alternation an LLM needs). The DESC+reverse is what makes the
		// window slide: a plain `ORDER BY ... ASC LIMIT N` freezes on the OLDEST N once a
		// thread passes N messages, so the latest turn never reaches callers (this is what
		// broke voice-reply at turn 7 — the prompt ended on a stale assistant turn → empty).
		const rows = db
			.prepare(
				'SELECT * FROM (SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'
			)
			.all(threadId, limit) as any[];

		return rows.map(parseRow);
	} catch (e: unknown) {
		console.error('getChatMessages error:', e);
		return [];
	} finally {
		db.close();
	}
}

/**
 * Delta fetch result for the thread short-circuit (Tier-1 detached recovery).
 * `latest_id` is the highest message id currently in the thread (0 when the
 * thread is empty) and `thread_updated` is the timestamp of its most recent
 * message (null when empty) — enough for a client holding a stale window to
 * cheaply confirm whether it is caught up.
 */
export interface ChatThreadDelta {
	messages: ChatMessage[];
	latest_id: number;
	thread_updated: string | null;
}

/**
 * Rows NEWER than `sinceId` (the last message id the client holds), ascending
 * by id, plus the thread's latest-id / latest-timestamp meta. When `limit` is
 * provided the OLDEST `limit` delta rows are returned so a client can page
 * forward by advancing `sinceId`; omitted means the full delta.
 */
export function getChatMessagesSince(
	sinceId: number,
	threadId = 'default',
	limit?: number
): ChatThreadDelta {
	if (!fs.existsSync(serverConfig.memoryDbPath)) {
		return { messages: [], latest_id: 0, thread_updated: null };
	}
	const db = getDb();
	try {
		const meta = db
			.prepare(
				'SELECT MAX(id) AS latest_id, MAX(timestamp) AS thread_updated FROM chat_messages WHERE thread_id = ?'
			)
			.get(threadId) as { latest_id: number | null; thread_updated: string | null } | undefined;
		const rows = (
			limit !== undefined && Number.isFinite(limit)
				? db
						.prepare(
							'SELECT * FROM chat_messages WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT ?'
						)
						.all(threadId, sinceId, limit)
				: db
						.prepare('SELECT * FROM chat_messages WHERE thread_id = ? AND id > ? ORDER BY id ASC')
						.all(threadId, sinceId)
		) as any[];
		return {
			messages: rows.map(parseRow),
			latest_id: meta?.latest_id ?? 0,
			thread_updated: meta?.thread_updated ?? null
		};
	} catch (e: unknown) {
		console.error('getChatMessagesSince error:', e);
		return { messages: [], latest_id: 0, thread_updated: null };
	} finally {
		db.close();
	}
}

export function getChatMessageCount(threadId = 'default'): number {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return 0;
	const db = getDb();
	try {
		const r = db
			.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?')
			.get(threadId) as { n: number } | undefined;
		return r?.n ?? 0;
	} catch (e: unknown) {
		console.error('getChatMessageCount error:', e);
		return 0;
	} finally {
		db.close();
	}
}

// Messages OLDER than the most recent `recentN` (history scrolled out of the
// hot window), ascending. Feeds the Layer-1 working-memory summary.
export function getMessagesBeforeRecent(recentN: number, threadId = 'default'): ChatMessage[] {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = getDb();
	try {
		const boundary = db
			.prepare('SELECT id FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?')
			.get(threadId, recentN - 1) as { id?: number } | undefined;
		if (!boundary?.id) return [];
		const rows = db
			.prepare('SELECT * FROM chat_messages WHERE thread_id = ? AND id < ? ORDER BY id ASC')
			.all(threadId, boundary.id) as any[];
		return rows.map(parseRow);
	} catch (e: unknown) {
		console.error('getMessagesBeforeRecent error:', e);
		return [];
	} finally {
		db.close();
	}
}
