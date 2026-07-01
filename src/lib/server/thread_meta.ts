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
import { purgeThreadArtifacts } from './artifactStore';

export interface ThreadMeta {
	thread_id: string;
	title: string;
	pinned: boolean;
	archived: boolean;
	summary: string | null;
	remember_flag: boolean;
	created_at: string;
	last_activity_at: string;
	/** ISO timestamp the thread was soft-deleted (moved to Recently Deleted), else null. */
	deleted_at: string | null;
}

/** Recently-Deleted trash retention window before a hard purge. */
export const TRASH_RETENTION_DAYS = 90;

/** A soft-deleted thread annotated with how long it has left before hard purge. */
export interface RecentlyDeletedThread extends ThreadMeta {
	deleted_at: string;
	days_remaining: number;
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
			last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			deleted_at TEXT NULL
		);
	`);
	// Idempotent migration for pre-existing DBs created before the trash column.
	// SQLite has no "ADD COLUMN IF NOT EXISTS"; the duplicate-column error on an
	// already-migrated DB is expected and swallowed.
	try {
		db.exec('ALTER TABLE chat_thread_meta ADD COLUMN deleted_at TEXT NULL');
	} catch {
		/* column already exists — safe to ignore */
	}
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
		last_activity_at: row.last_activity_at,
		deleted_at: row.deleted_at ?? null
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

// ---------------------------------------------------------------------------
// Recently-Deleted (trash) — soft-delete data model.
//
// "Delete" is a SOFT delete: it stamps chat_thread_meta.deleted_at with now.
// The thread leaves the active list, enters Recently Deleted, is restorable for
// TRASH_RETENTION_DAYS, then hard-purged. This is SEPARATE from the existing
// `archived` flag (which stays exactly as-is, including its Tier-0 emission).
// ---------------------------------------------------------------------------

/**
 * Soft-delete a thread — move it to Recently Deleted. Ensures a meta row exists
 * first so ghost/active threads (no prior meta) can still be trashed. Idempotent:
 * a re-delete preserves the ORIGINAL deleted_at (only stamps when currently null)
 * so days_remaining doesn't reset on a repeat call.
 */
export function softDeleteThread(threadId: string): { ok: boolean } {
	if (!dbExists()) return { ok: false };
	const db = getDb();
	try {
		ensureTable(db);
		db.prepare(
			`INSERT INTO chat_thread_meta (thread_id) VALUES (?) ON CONFLICT(thread_id) DO NOTHING`
		).run(threadId);
		db.prepare(
			'UPDATE chat_thread_meta SET deleted_at = ? WHERE thread_id = ? AND deleted_at IS NULL'
		).run(new Date().toISOString(), threadId);
		return { ok: true };
	} catch (e) {
		console.error('softDeleteThread error:', e);
		return { ok: false };
	} finally {
		db.close();
	}
}

/** Restore a soft-deleted thread — clear deleted_at (back to the active list). Idempotent. */
export function restoreThread(threadId: string): { ok: boolean } {
	if (!dbExists()) return { ok: false };
	const db = getDb();
	try {
		ensureTable(db);
		db.prepare('UPDATE chat_thread_meta SET deleted_at = NULL WHERE thread_id = ?').run(threadId);
		return { ok: true };
	} catch (e) {
		console.error('restoreThread error:', e);
		return { ok: false };
	} finally {
		db.close();
	}
}

/**
 * List threads currently in Recently Deleted: deleted_at set AND still within the
 * retention window, newest-deleted first, each annotated with days_remaining
 * (whole days until hard purge). Expired rows are excluded here — purgeExpiredDeleted
 * removes them from disk.
 */
export function listRecentlyDeleted(): RecentlyDeletedThread[] {
	if (!dbExists()) return [];
	const db = getDb();
	try {
		ensureTable(db);
		const rows = db
			.prepare(
				`SELECT * FROM chat_thread_meta
				 WHERE deleted_at IS NOT NULL
				 ORDER BY deleted_at DESC`
			)
			.all() as any[];
		const now = Date.now();
		const out: RecentlyDeletedThread[] = [];
		for (const row of rows) {
			const deletedAt = String(row.deleted_at);
			const parsed = new Date(deletedAt).getTime();
			if (Number.isNaN(parsed)) continue;
			const ageDays = (now - parsed) / 86_400_000;
			if (ageDays >= TRASH_RETENTION_DAYS) continue; // expired — belongs to purge, not the list
			const daysRemaining = Math.max(0, Math.ceil(TRASH_RETENTION_DAYS - ageDays));
			out.push({ ...rowToMeta(row), deleted_at: deletedAt, days_remaining: daysRemaining });
		}
		return out;
	} catch (e) {
		console.error('listRecentlyDeleted error:', e);
		return [];
	} finally {
		db.close();
	}
}

/**
 * Hard-purge every thread whose deleted_at is older than the retention window.
 * Each expired thread runs the FULL hard-delete cascade. Returns the count purged.
 * The expired ids are read first (read-only), then each is cascaded independently
 * so one failure doesn't abort the rest.
 */
export function purgeExpiredDeleted(): number {
	if (!dbExists()) return 0;
	const db = getDb();
	let expired: string[] = [];
	try {
		ensureTable(db);
		const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86_400_000).toISOString();
		// ISO-8601 timestamps compare correctly as text.
		const rows = db
			.prepare(
				'SELECT thread_id FROM chat_thread_meta WHERE deleted_at IS NOT NULL AND deleted_at <= ?'
			)
			.all(cutoff) as any[];
		expired = rows.map((r) => String(r.thread_id));
	} catch (e) {
		console.error('purgeExpiredDeleted scan error:', e);
		expired = [];
	} finally {
		db.close();
	}

	let purged = 0;
	for (const tid of expired) {
		if (hardDeleteThreadCascade(tid).ok) purged++;
	}
	return purged;
}

/**
 * Gather every trace/task id that could key on-disk artifacts for a thread, BEFORE
 * any cascade deletes those rows. Unions chat_messages.trace_id + chat_messages.task_id
 * + pending_jobs.trace_id. Each source is guarded so a missing column/table can't
 * abort the collection. Callers pass the result to purgeThreadArtifacts (which also
 * scans manifests by thread_id as a second keying path).
 */
export function collectThreadTraceIds(threadId: string): string[] {
	if (!dbExists()) return [];
	const db = getDb();
	const ids = new Set<string>();
	try {
		try {
			for (const r of db
				.prepare(
					'SELECT DISTINCT trace_id FROM chat_messages WHERE thread_id = ? AND trace_id IS NOT NULL'
				)
				.all(threadId) as any[]) {
				if (r.trace_id) ids.add(String(r.trace_id));
			}
		} catch {
			/* column/table absent — skip */
		}
		try {
			for (const r of db
				.prepare(
					'SELECT DISTINCT task_id FROM chat_messages WHERE thread_id = ? AND task_id IS NOT NULL'
				)
				.all(threadId) as any[]) {
				if (r.task_id) ids.add(String(r.task_id));
			}
		} catch {
			/* column/table absent — skip */
		}
		try {
			for (const r of db
				.prepare(
					'SELECT DISTINCT trace_id FROM pending_jobs WHERE thread_id = ? AND trace_id IS NOT NULL'
				)
				.all(threadId) as any[]) {
				if (r.trace_id) ids.add(String(r.trace_id));
			}
		} catch {
			/* pending_jobs absent — skip */
		}
	} finally {
		db.close();
	}
	return [...ids];
}

/**
 * The single, complete hard-delete cascade. Reused by delete-now, purge, and the
 * legacy archived-delete (deleteThread). Removes EVERYTHING the thread owns so
 * nothing orphans:
 *   chat_messages + chat_drafts + chat_thread_state + observations + pending_jobs
 *   + chat_thread_meta (in one transaction), then the on-disk artifact store dirs.
 *
 * Ordering matters: the artifact trace ids are collected BEFORE the transaction
 * deletes chat_messages/pending_jobs (those rows carry the ids that resolve store
 * dirs), and purgeThreadArtifacts (filesystem rm) runs AFTER the transaction
 * commits — never inside the DB txn.
 */
export function hardDeleteThreadCascade(threadId: string): { ok: boolean; reason?: string } {
	if (!dbExists()) return { ok: false, reason: 'db_not_found' };

	// 1. Collect artifact keys BEFORE any deletes — losing these would orphan files.
	const traceIds = collectThreadTraceIds(threadId);

	// 2. Transactional row cascade.
	const db = getDb();
	try {
		ensureTable(db);
		db.transaction(() => {
			// chat_messages is authoritative (always present post-bootstrap). The rest
			// are best-effort: a table that doesn't exist on a given DB must NOT abort
			// the whole cascade (that would roll back everything and orphan artifacts).
			db.prepare('DELETE FROM chat_messages WHERE thread_id = ?').run(threadId);
			try {
				db.prepare('DELETE FROM chat_drafts WHERE thread_id = ?').run(threadId);
			} catch {
				/* table might not exist */
			}
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
			try {
				db.prepare('DELETE FROM pending_jobs WHERE thread_id = ?').run(threadId);
			} catch {
				/* table might not exist */
			}
			db.prepare('DELETE FROM chat_thread_meta WHERE thread_id = ?').run(threadId);
		})();
	} catch (e) {
		console.error('hardDeleteThreadCascade error:', e);
		return { ok: false, reason: 'internal_error' };
	} finally {
		db.close();
	}

	// 3. On-disk artifact purge AFTER commit — filesystem work outside the txn.
	try {
		purgeThreadArtifacts(threadId, traceIds);
	} catch (e) {
		console.error('hardDeleteThreadCascade artifact purge error:', e);
	}

	return { ok: true };
}

/**
 * Delete a thread and all its associated data (LEGACY archived-delete path).
 * Only allowed when the thread is already archived — returns false if the thread
 * is active. The full cascade (incl. pending_jobs + on-disk artifacts) is routed
 * through hardDeleteThreadCascade so this path can never orphan data.
 *
 * Previously protected 'default' from deletion. Operator directive 2026-05-27:
 * default is a thread like any other. If the operator deletes everything,
 * sending a message creates a fresh thread on the fly — no special-case row
 * needs to exist on the server.
 */
export function deleteThread(threadId: string): { ok: boolean; reason?: string } {
	if (!dbExists()) return { ok: false, reason: 'db_not_found' };

	// Archived-first gate — read-only, on its own connection.
	const db = getDb();
	let blocked = false;
	try {
		ensureTable(db);
		const meta = db
			.prepare('SELECT archived FROM chat_thread_meta WHERE thread_id = ?')
			.get(threadId) as { archived: number } | undefined;
		// If it exists in meta, it MUST be archived to delete. If it's not in meta
		// (a "ghost" thread), we allow deletion.
		if (meta && !meta.archived) blocked = true;
	} catch (e) {
		console.error('deleteThread gate error:', e);
		return { ok: false, reason: 'internal_error' };
	} finally {
		db.close();
	}

	if (blocked) return { ok: false, reason: 'not_archived' };
	return hardDeleteThreadCascade(threadId);
}
