import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

export interface ChatActivity {
	id: number;
	trace_id: string;
	action: string;
	target: string | null;
	timestamp: string;
}

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath, { readonly: true });
}

/**
 * Fetch every activity row for a given trace_id, ordered oldest-first so the
 * UI can append to a stack as it polls.
 */
export function getActivityForTrace(traceId: string, limit = 200): ChatActivity[] {
	if (!traceId || !fs.existsSync(serverConfig.memoryDbPath)) {
		return [];
	}
	const db = getDb();
	try {
		const rows = db
			.prepare(
				`SELECT id, trace_id, action, target, timestamp
				 FROM chat_activity
				 WHERE trace_id = ?
				 ORDER BY id ASC
				 LIMIT ?`
			)
			.all(traceId, limit) as ChatActivity[];
		return rows;
	} catch (e: unknown) {
		console.error('getActivityForTrace error:', e);
		return [];
	} finally {
		db.close();
	}
}

/**
 * Fetch the most recent activity row across the most-recent N traces. Used as
 * a "what worker activity exists right now" probe when the UI doesn't know
 * which trace_id to ask about.
 */
export function getRecentActivity(limit = 100): ChatActivity[] {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return [];
	const db = getDb();
	try {
		const rows = db
			.prepare(
				`SELECT id, trace_id, action, target, timestamp
				 FROM chat_activity
				 ORDER BY id DESC
				 LIMIT ?`
			)
			.all(limit) as ChatActivity[];
		// Return chronologically so the UI doesn't have to re-sort.
		return rows.reverse();
	} catch (e: unknown) {
		console.error('getRecentActivity error:', e);
		return [];
	} finally {
		db.close();
	}
}
