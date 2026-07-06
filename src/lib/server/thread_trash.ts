// ---------------------------------------------------------------------------
// Recently-Deleted (trash) — soft-delete data model.
//
// "Delete" is a SOFT delete: it stamps chat_thread_meta.deleted_at with now.
// The thread leaves the active list, enters Recently Deleted, is restorable for
// TRASH_RETENTION_DAYS, then hard-purged. This is SEPARATE from the existing
// `archived` flag (which stays exactly as-is, including its Tier-0 emission).
// ---------------------------------------------------------------------------

import { ensureTable, getDb, dbExists, rowToMeta, type ThreadMeta } from './thread_meta_db';
import { hardDeleteThreadCascade } from './thread_delete_cascade';

/** Recently-Deleted trash retention window before a hard purge. */
export const TRASH_RETENTION_DAYS = 90;

/** A soft-deleted thread annotated with how long it has left before hard purge. */
export interface RecentlyDeletedThread extends ThreadMeta {
	deleted_at: string;
	days_remaining: number;
}

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
