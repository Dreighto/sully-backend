import fs from 'node:fs';
import { serverConfig } from '../config';
import { getDb } from './messages_read';

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
