// CRUD helpers for chat_thread_meta — titles, pin, archive, summary, remember.
//
// The table is a sibling to chat_thread_state (PR 1c). Created lazily on first
// write; no migration script needed — CREATE TABLE IF NOT EXISTS handles it.
//
// Ordering contract: pinned first (arbitrary order within pinned), then
// active by last_activity_at DESC, then archived in a separate bucket.

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

export interface ThreadMeta {
	thread_id: string;
	title: string;
	pinned: boolean;
	archived: boolean;
	summary: string | null;
	remember_flag: boolean;
	created_at: string;
	last_activity_at: string;
}

const ensuredPaths = new Set<string>();

function ensureTable(db: Database.Database): void {
	const key = serverConfig.memoryDbPath;
	if (ensuredPaths.has(key)) return;
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
		);
	`);
	ensuredPaths.add(key);
}

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

function dbExists(): boolean {
	return fs.existsSync(serverConfig.memoryDbPath);
}

function rowToMeta(row: any): ThreadMeta {
	return {
		thread_id: row.thread_id,
		title: row.title,
		pinned: Boolean(row.pinned),
		archived: Boolean(row.archived),
		summary: row.summary ?? null,
		remember_flag: Boolean(row.remember_flag),
		created_at: row.created_at,
		last_activity_at: row.last_activity_at
	};
}

/** Returns {active, archived} lists. Pinned threads are first within active. */
export function listThreadMeta(): { active: ThreadMeta[]; archived: ThreadMeta[] } {
	if (!dbExists()) return { active: [], archived: [] };
	const db = getDb();
	try {
		ensureTable(db);
		const rows = db
			.prepare(
				`SELECT * FROM chat_thread_meta
				 ORDER BY
					archived ASC,
					pinned DESC,
					last_activity_at DESC`
			)
			.all() as any[];
		const metas = rows.map(rowToMeta);
		return {
			active: metas.filter((m) => !m.archived),
			archived: metas.filter((m) => m.archived)
		};
	} catch (e) {
		console.error('listThreadMeta error:', e);
		return { active: [], archived: [] };
	} finally {
		db.close();
	}
}

export function getThreadMeta(threadId: string): ThreadMeta | null {
	if (!dbExists()) return null;
	const db = getDb();
	try {
		ensureTable(db);
		const row = db
			.prepare('SELECT * FROM chat_thread_meta WHERE thread_id = ?')
			.get(threadId) as any | undefined;
		return row ? rowToMeta(row) : null;
	} catch (e) {
		console.error('getThreadMeta error:', e);
		return null;
	} finally {
		db.close();
	}
}

/** Upsert — creates the row if it doesn't exist. */
export function upsertThreadMeta(
	threadId: string,
	fields: Partial<Omit<ThreadMeta, 'thread_id' | 'created_at'>>
): void {
	if (!dbExists()) return;
	const db = getDb();
	try {
		ensureTable(db);
		// Ensure the row exists first.
		db.prepare(`
			INSERT INTO chat_thread_meta (thread_id) VALUES (?)
			ON CONFLICT(thread_id) DO NOTHING
		`).run(threadId);

		// Apply each provided field individually to avoid clobbering untouched columns.
		if (fields.title !== undefined) {
			db.prepare('UPDATE chat_thread_meta SET title = ? WHERE thread_id = ?').run(
				fields.title,
				threadId
			);
		}
		if (fields.pinned !== undefined) {
			db.prepare('UPDATE chat_thread_meta SET pinned = ? WHERE thread_id = ?').run(
				fields.pinned ? 1 : 0,
				threadId
			);
		}
		if (fields.archived !== undefined) {
			db.prepare('UPDATE chat_thread_meta SET archived = ? WHERE thread_id = ?').run(
				fields.archived ? 1 : 0,
				threadId
			);
		}
		if (fields.summary !== undefined) {
			db.prepare('UPDATE chat_thread_meta SET summary = ? WHERE thread_id = ?').run(
				fields.summary,
				threadId
			);
		}
		if (fields.remember_flag !== undefined) {
			db.prepare('UPDATE chat_thread_meta SET remember_flag = ? WHERE thread_id = ?').run(
				fields.remember_flag ? 1 : 0,
				threadId
			);
		}
		if (fields.last_activity_at !== undefined) {
			db.prepare(
				'UPDATE chat_thread_meta SET last_activity_at = ? WHERE thread_id = ?'
			).run(fields.last_activity_at, threadId);
		}
	} catch (e) {
		console.error('upsertThreadMeta error:', e);
	} finally {
		db.close();
	}
}

export function setPin(threadId: string, pinned: boolean): void {
	upsertThreadMeta(threadId, { pinned });
}

export function setArchived(threadId: string, archived: boolean): void {
	upsertThreadMeta(threadId, { archived });
}

export function setTitle(threadId: string, title: string): void {
	upsertThreadMeta(threadId, { title: title.trim() || 'New thread' });
}

export function setSummary(threadId: string, summary: string): void {
	upsertThreadMeta(threadId, { summary });
}

export function setRememberFlag(threadId: string, flag: boolean): void {
	upsertThreadMeta(threadId, { remember_flag: flag });
}

export function touchLastActivity(threadId: string): void {
	upsertThreadMeta(threadId, { last_activity_at: new Date().toISOString() });
}

/**
 * Delete a thread and all its associated data. Only allowed when the thread
 * is already archived — returns false if the thread is active.
 * Cascade: chat_messages + chat_drafts + chat_thread_state + chat_thread_meta + observations.
 *
 * Previously protected 'default' from deletion. Operator directive 2026-05-27:
 * default is a thread like any other. If the operator deletes everything,
 * sending a message creates a fresh thread on the fly — no special-case row
 * needs to exist on the server.
 */
export function deleteThread(threadId: string): { ok: boolean; reason?: string } {
	if (!dbExists()) return { ok: false, reason: 'db_not_found' };
	const db = getDb();
	try {
		ensureTable(db);
		const meta = db
			.prepare('SELECT archived FROM chat_thread_meta WHERE thread_id = ?')
			.get(threadId) as { archived: number } | undefined;

		// If it exists in meta, it MUST be archived to delete.
		if (meta && !meta.archived) {
			return { ok: false, reason: 'not_archived' };
		}

		// If it doesn't exist in meta, but has messages, we still check if it's
		// effectively "active". But if the user is calling DELETE, we should
		// probably allow it if it's not the default thread and not explicitly
		// marked as active in meta.
		// For now, if it's not in meta, we allow deletion (it's a "ghost" thread).

		db.transaction(() => {
			db.prepare('DELETE FROM chat_messages WHERE thread_id = ?').run(threadId);
			db.prepare('DELETE FROM chat_drafts WHERE thread_id = ?').run(threadId);
			// These tables might not exist or might not have entries — run and ignore.
			try {
				db.prepare('DELETE FROM chat_thread_state WHERE thread_id = ?').run(threadId);
			} catch {
				/* table might not exist */
			}
			try {
				db.prepare('DELETE FROM observations WHERE chat_thread_id = ?').run(threadId);
			} catch {
				/* table might not exist */
			}
			db.prepare('DELETE FROM chat_thread_meta WHERE thread_id = ?').run(threadId);
		})();

		return { ok: true };
	} catch (e) {
		console.error('deleteThread error:', e);
		return { ok: false, reason: 'internal_error' };
	} finally {
		db.close();
	}
}
