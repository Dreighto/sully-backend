// CRUD helpers for chat_thread_meta — titles, pin, archive, summary, remember.
//
// The table is a sibling to chat_thread_state (PR 1c). Created lazily on first
// write; no migration script needed — CREATE TABLE IF NOT EXISTS handles it.
//
// Ordering contract: pinned first (arbitrary order within pinned), then
// active by last_activity_at DESC, then archived in a separate bucket.
//
// Wave 2 split (2026-07-06): the DB bootstrap moved to thread_meta_db.ts, the
// Recently-Deleted trash model to thread_trash.ts, and the hard-delete
// cascade to thread_delete_cascade.ts. This file is kept as the CRUD core +
// a re-export barrel — 15+ external importers keep working unchanged.

import { ensureTable, getDb, dbExists, rowToMeta, type ThreadMeta } from './thread_meta_db';

export type { ThreadMeta } from './thread_meta_db';
export {
	TRASH_RETENTION_DAYS,
	softDeleteThread,
	restoreThread,
	listRecentlyDeleted,
	purgeExpiredDeleted,
	type RecentlyDeletedThread
} from './thread_trash';
export {
	collectThreadTraceIds,
	hardDeleteThreadCascade,
	deleteThread
} from './thread_delete_cascade';

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
		const row = db.prepare('SELECT * FROM chat_thread_meta WHERE thread_id = ?').get(threadId) as
			| any
			| undefined;
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
		db.prepare(
			`
			INSERT INTO chat_thread_meta (thread_id) VALUES (?)
			ON CONFLICT(thread_id) DO NOTHING
		`
		).run(threadId);

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
			db.prepare('UPDATE chat_thread_meta SET last_activity_at = ? WHERE thread_id = ?').run(
				fields.last_activity_at,
				threadId
			);
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
