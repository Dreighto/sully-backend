import { purgeThreadArtifacts } from './artifactStore';
import { ensureTable, getDb, dbExists } from './thread_meta_db';

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
