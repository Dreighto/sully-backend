import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';
import type { ChatMessage, InteractiveAction } from '$lib/types/chat';

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

function parseRow(row: any): ChatMessage {
	let interactive_action: InteractiveAction | null = null;
	if (row.interactive_action) {
		try {
			interactive_action = JSON.parse(row.interactive_action);
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

/**
 * Single-operator chat UI state — survives page reloads + device switches.
 * The chat_user_state table has one row keyed 'operator'; we just store
 * which thread the operator was last viewing so that leaving the app and
 * coming back (or switching phone↔desktop) lands them in the right thread
 * instead of defaulting to 'default'.
 */
export function getActiveThread(): string {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return 'default';
	const db = getDb();
	try {
		const row = db
			.prepare("SELECT last_thread FROM chat_user_state WHERE user_id = 'operator'")
			.get() as { last_thread?: string } | undefined;
		const cached = row?.last_thread;
		if (!cached || cached === 'default') return 'default';

		// Reconcile against reality. The cached last_thread can point at a
		// thread that no longer has messages OR was never persisted (operator
		// typed /new in a thread that errored out before its first message
		// landed). Audit 2026-05-27 caught a phantom "testing" thread that
		// pointed at nothing — page-reload landed on an empty fantasy thread.
		// Fall back to the most-recently-active real thread, or 'default'.
		const existsRow = db
			.prepare(
				`SELECT
					EXISTS(SELECT 1 FROM chat_messages WHERE thread_id = ?) AS in_msg,
					EXISTS(SELECT 1 FROM chat_thread_meta WHERE thread_id = ?) AS in_meta`
			)
			.get(cached, cached) as { in_msg: number; in_meta: number } | undefined;
		if (existsRow && (existsRow.in_msg || existsRow.in_meta)) return cached;

		const latest = db
			.prepare(
				`SELECT thread_id FROM chat_messages
				 GROUP BY thread_id
				 ORDER BY MAX(timestamp) DESC
				 LIMIT 1`
			)
			.get() as { thread_id?: string } | undefined;
		return latest?.thread_id || 'default';
	} catch (e: unknown) {
		console.error('getActiveThread error:', e);
		return 'default';
	} finally {
		db.close();
	}
}

export function setActiveThread(threadId: string): void {
	const t = (threadId || '').trim() || 'default';
	const db = new Database(serverConfig.memoryDbPath);
	try {
		db.prepare(
			`INSERT INTO chat_user_state (user_id, last_thread, updated_at)
			 VALUES ('operator', ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(user_id) DO UPDATE SET last_thread = excluded.last_thread, updated_at = CURRENT_TIMESTAMP`
		).run(t);
	} catch (e: unknown) {
		console.error('setActiveThread error:', e);
	} finally {
		db.close();
	}
}

/**
 * RAW read of the persisted last-active thread — NO reconciliation. Unlike
 * getActiveThread() (which falls back to the latest real thread / 'default' for
 * the state endpoint), this returns exactly what's stored so the restore order
 * can apply its own existence gate. Returns null when nothing is persisted.
 */
export function getLastActiveThread(): string | null {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return null;
	const db = getDb();
	try {
		const row = db
			.prepare("SELECT last_thread FROM chat_user_state WHERE user_id = 'operator'")
			.get() as { last_thread?: string } | undefined;
		const v = (row?.last_thread || '').trim();
		return v || null;
	} catch (e: unknown) {
		console.error('getLastActiveThread error:', e);
		return null;
	} finally {
		db.close();
	}
}

/**
 * A thread "exists" if it has at least one message OR a meta row. chat_messages
 * is guaranteed present post-bootstrap; chat_thread_meta self-creates lazily, so
 * its probe is guarded separately — a missing meta table must not mask a real
 * messages hit.
 */
export function threadExists(threadId: string): boolean {
	const t = (threadId || '').trim();
	if (!t) return false;
	if (!fs.existsSync(serverConfig.memoryDbPath)) return false;
	const db = getDb();
	try {
		const inMsg = db.prepare('SELECT 1 FROM chat_messages WHERE thread_id = ? LIMIT 1').get(t);
		if (inMsg) return true;
		try {
			const inMeta = db
				.prepare('SELECT 1 FROM chat_thread_meta WHERE thread_id = ? LIMIT 1')
				.get(t);
			if (inMeta) return true;
		} catch {
			/* chat_thread_meta not created yet — the messages probe above is authoritative */
		}
		return false;
	} catch (e: unknown) {
		console.error('threadExists error:', e);
		return false;
	} finally {
		db.close();
	}
}

/**
 * Resolve which thread a bare/​deep-linked chat open should land on, applying the
 * locked restore order EXACTLY:
 *
 *   1. URL param (`?thread=`) — only if it resolves to a real thread.
 *   2. else the persisted last-active thread (`chat_user_state.last_thread`)…
 *   3. …validated to still exist — a deleted thread falls through.
 *   4. else a fresh thread — ONLY as a last resort.
 *
 * `freshId` is generated by the caller (random/time-based) so this function stays
 * pure-over-the-DB and unit-testable. `deepLinkMiss` is true when a thread WAS
 * requested but could not be honored AND we landed on a real existing thread
 * instead (so the caller can show a plain-English "showing your latest chat"
 * fallback). It stays false when we fall through to a fresh thread — there's no
 * prior conversation to apologize for.
 */
export function resolveInitialThread(
	queryThread: string | null | undefined,
	freshId: string
): { thread: string; deepLinkMiss: boolean } {
	const q = (queryThread || '').trim();
	// 1. URL param, only if it resolves to a real thread.
	if (q && threadExists(q)) return { thread: q, deepLinkMiss: false };
	// 2 + 3. Persisted last-active, validated to still exist.
	const last = getLastActiveThread();
	if (last && threadExists(last)) {
		// q was set (a deep-link / explicit thread) but didn't resolve, and we have
		// a real thread to fall back to → signal the plain-English fallback.
		return { thread: last, deepLinkMiss: !!q };
	}
	// 4. Fresh thread — last resort. No prior conversation to point at.
	return { thread: freshId, deepLinkMiss: false };
}

/**
 * List distinct threads in chat_messages with a count + latest activity.
 * Used by the chat tab's thread switcher.
 *
 * Threads soft-deleted into Recently Deleted (chat_thread_meta.deleted_at set)
 * are EXCLUDED so they never surface in the active switcher — restored/purged
 * via the trash flow instead. Ghost threads with no meta row still appear
 * (LEFT JOIN → deleted_at NULL). The guarded CREATE TABLE + ALTER mirror the
 * lazy-migration pattern in searchChatMessages so the JOIN can't blow up on an
 * older DB that predates chat_thread_meta / the deleted_at column.
 */
export function listChatThreads(): {
	thread_id: string;
	message_count: number;
	latest_ts: string;
}[] {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = getDb();
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS chat_thread_meta (
				thread_id TEXT PRIMARY KEY,
				title TEXT NOT NULL DEFAULT 'New thread',
				pinned BOOLEAN NOT NULL DEFAULT 0,
				archived BOOLEAN NOT NULL DEFAULT 0,
				summary TEXT NULL,
				remember_flag BOOLEAN NOT NULL DEFAULT 0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				deleted_at TEXT NULL
			)
		`);
		try {
			db.exec('ALTER TABLE chat_thread_meta ADD COLUMN deleted_at TEXT NULL');
		} catch {
			/* column already exists — safe to ignore */
		}
		const rows = db
			.prepare(
				`SELECT m.thread_id AS thread_id,
				        COUNT(*) AS message_count,
				        MAX(m.timestamp) AS latest_ts
				 FROM chat_messages m
				 LEFT JOIN chat_thread_meta tm ON tm.thread_id = m.thread_id
				 WHERE tm.deleted_at IS NULL
				 GROUP BY m.thread_id
				 ORDER BY latest_ts DESC`
			)
			.all() as any[];
		return rows.map((r) => ({
			thread_id: r.thread_id || 'default',
			message_count: r.message_count,
			latest_ts: r.latest_ts
		}));
	} catch (e: unknown) {
		console.error('listChatThreads error:', e);
		return [];
	} finally {
		db.close();
	}
}

export interface SearchResult {
	message_id: number;
	thread_id: string;
	thread_title: string;
	snippet: string;
	timestamp: string;
	sender: string;
}

/**
 * Full-history message search across all threads. Returns up to `limit` results
 * ordered by recency, each annotated with its thread title from chat_thread_meta.
 * The query is LIKE-based (case-insensitive via SQLite's case_sensitive_like
 * being OFF by default for ASCII) so no FTS extension is required.
 */
export function searchChatMessages(query: string, limit = 30): SearchResult[] {
	if (!query || !query.trim()) return [];
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = getDb();
	try {
		// Ensure chat_thread_meta exists before the LEFT JOIN — it's created
		// lazily by thread_meta.ts but may not yet exist on a fresh DB.
		db.exec(`
			CREATE TABLE IF NOT EXISTS chat_thread_meta (
				thread_id TEXT PRIMARY KEY,
				title TEXT NOT NULL DEFAULT 'New thread',
				pinned BOOLEAN NOT NULL DEFAULT 0,
				archived BOOLEAN NOT NULL DEFAULT 0,
				summary TEXT NULL,
				remember_flag BOOLEAN NOT NULL DEFAULT 0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
		const term = `%${query.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
		const rows = db
			.prepare(
				`SELECT m.id        AS message_id,
				        m.thread_id,
				        COALESCE(tm.title, m.thread_id) AS thread_title,
				        m.message   AS snippet,
				        m.timestamp,
				        m.sender
				 FROM chat_messages m
				 LEFT JOIN chat_thread_meta tm ON tm.thread_id = m.thread_id
				 WHERE m.message LIKE ? ESCAPE '\\'
				 ORDER BY m.id DESC
				 LIMIT ?`
			)
			.all(term, limit) as any[];
		return rows.map((r) => ({
			message_id: r.message_id,
			thread_id: r.thread_id || 'default',
			thread_title: r.thread_title || r.thread_id || 'default',
			snippet: r.snippet,
			timestamp: r.timestamp,
			sender: r.sender
		}));
	} catch (e) {
		console.error('searchChatMessages error:', e);
		return [];
	} finally {
		db.close();
	}
}

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

// Delete a single chat message by id. Used by the regenerate flow to remove
// the old assistant reply before re-streaming a new one. Returns true if a
// row was actually deleted, false otherwise — caller can decide whether a
// missing id is an error.
export function deleteChatMessage(messageId: number): boolean {
	const db = getDb();
	try {
		const info = db.prepare('DELETE FROM chat_messages WHERE id = ?').run(messageId);
		return info.changes > 0;
	} catch (e: unknown) {
		console.error('deleteChatMessage error:', e);
		return false;
	} finally {
		db.close();
	}
}

// The set of `sender` labels a CHAT ASSISTANT reply can carry (CLI/direct/local
// paths persist 'cc' | 'agy' | 'local'; 'companion' covers the companion-mode
// label). Deliberately EXCLUDES 'operator' (the human turn) and 'system' (the
// dispatch ACK / working-bubble rows) so a scoped delete can never touch either.
const CHAT_REPLY_SENDERS = ['agy', 'local', 'cc', 'companion'] as const;

// Stage 3a (replace-reply-on-reuse): delete the PRIOR chat assistant reply row(s)
// for one Task. On a keyed operator-turn REUSE (a retry/regenerate re-POST of the
// same logical turn — same client_turn_id → same reused task_id), the turn produces
// a NEW assistant reply; without this the stale prior reply survives and reappears
// on the next history sync/reopen. Scoped TIGHTLY by (task_id AND sender IN the
// chat-reply set): never removes the operator row, never removes the system/dispatch
// ACK, and — because it keys on the exact reused task_id — never touches a synthesis
// reply belonging to a DIFFERENT turn. On a retry-of-a-failed-send (reused but no
// prior reply exists) it is a harmless no-op (0 rows). Returns the count deleted.
// Guarded against a pre-migration DB (missing column / file) — returns 0.
export function deleteChatRepliesForTask(taskId: string): number {
	if (!taskId) return 0;
	if (!fs.existsSync(serverConfig.memoryDbPath)) return 0;
	const db = getDb();
	try {
		const placeholders = CHAT_REPLY_SENDERS.map(() => '?').join(', ');
		const info = db
			.prepare(
				`DELETE FROM chat_messages
				 WHERE task_id = ? AND sender IN (${placeholders})`
			)
			.run(taskId, ...CHAT_REPLY_SENDERS);
		return info.changes;
	} catch (e: unknown) {
		console.error('deleteChatRepliesForTask error:', e);
		return 0;
	} finally {
		db.close();
	}
}

// Flip a 'pending_approval' proposal message (matched by trace_id) to a
// terminal status so its tap-to-confirm buttons clear. Scoped to
// 'pending_approval' so it can never disturb a normal 'sent' row. Returns the
// row count updated. Used by the ask-before-dispatch confirm endpoint.
export function resolveProposalMessage(traceId: string, status: 'approved' | 'denied'): number {
	const db = getDb();
	try {
		const info = db
			.prepare(
				"UPDATE chat_messages SET status = ? WHERE trace_id = ? AND status = 'pending_approval'"
			)
			.run(status, traceId);
		return info.changes;
	} catch (e: unknown) {
		console.error('resolveProposalMessage error:', e);
		return 0;
	} finally {
		db.close();
	}
}

// Operator's explicit feedback on an assistant reply. `+1` = thumbs-up,
// `-1` = thumbs-down, `null` = clear any prior signal. Returns the row count
// updated (0 = message_id not found). Only persists; the explicit-positive
// fine-tune corpus is harvested out-of-band by scripts/finetune/.
export function setMessageQualitySignal(messageId: number, signal: 1 | -1 | null): boolean {
	const db = getDb();
	try {
		const info = db
			.prepare('UPDATE chat_messages SET quality_signal = ? WHERE id = ?')
			.run(signal, messageId);
		return info.changes > 0;
	} catch (e: unknown) {
		console.error('setMessageQualitySignal error:', e);
		return false;
	} finally {
		db.close();
	}
}

export function updateActionStatus(messageId: number, status: 'approved' | 'denied'): boolean {
	const db = getDb();
	try {
		// First get the existing message
		const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId) as any;
		if (!row) return false;

		let interactive_action: InteractiveAction | null = null;
		if (row.interactive_action) {
			try {
				interactive_action = JSON.parse(row.interactive_action);
			} catch {
				interactive_action = null;
			}
		}

		if (interactive_action) {
			interactive_action.status = status;
			const actionStr = JSON.stringify(interactive_action);

			db.prepare('UPDATE chat_messages SET status = ?, interactive_action = ? WHERE id = ?').run(
				status,
				actionStr,
				messageId
			);
			return true;
		}

		return false;
	} catch (e: unknown) {
		console.error('updateActionStatus error:', e);
		return false;
	} finally {
		db.close();
	}
}
