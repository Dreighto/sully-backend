import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

let _activityEnsured = false;
function ensureActivityTable(db: Database.Database): void {
	if (_activityEnsured) return;
	db.exec(`
		CREATE TABLE IF NOT EXISTS chat_activity (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			trace_id TEXT NOT NULL,
			action TEXT NOT NULL,
			target TEXT,
			timestamp TEXT DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_chat_activity_trace ON chat_activity(trace_id, timestamp);
	`);
	_activityEnsured = true;
}

// The Task-journal event vocabulary (Phase 1). The original worker-progress
// actions (reading|edited|ran|thinking|completed|failed) stay valid — workers
// still emit them. These NEW actions are emitted by Sully's own turn pipeline
// so the journal records every turn, not just dispatched ones. Kept as a const
// list (not a hard enum on the column) so an unexpected worker action still
// lands; unknown actions are logged, not dropped.
export const TASK_EVENT_ACTIONS = [
	// worker-progress (legacy, still emitted by workers)
	'reading',
	'edited',
	'ran',
	'thinking',
	'completed',
	'failed',
	// Sully's own turn pipeline (Phase 1+)
	'task_proposed',
	'classifier_ran',
	'gate_evaluated',
	'brakes_evaluated',
	'provider_attempted',
	'provider_fell_through',
	'tool_invoked',
	'tool_result',
	'guardrail_triggered',
	'reply_persisted',
	'synthesis_started',
	'synthesis_completed',
	'verification_poll',
	'adversary_reviewed'
] as const;

/**
 * Write a single activity row into companion.db. The dispatched worker can't
 * reach the DB directly, so it HTTP-calls POST /api/chat/activity which calls
 * this. (The kernel emit_chat_activity.py writes logueos_memory.db, the wrong DB
 * for the companion.) action ∈ TASK_EVENT_ACTIONS (open — unknown still lands).
 */
export function writeActivity(traceId: string, action: string, target: string | null): void {
	if (!traceId || !action) return;
	const db = new Database(serverConfig.memoryDbPath);
	try {
		ensureActivityTable(db);
		db.prepare('INSERT INTO chat_activity (trace_id, action, target) VALUES (?, ?, ?)').run(
			traceId,
			action,
			target ?? null
		);
	} finally {
		db.close();
	}
}

/**
 * Convenience wrapper for emitting a Task-journal event from Sully's own
 * pipeline. `detail` is serialized to the `target` column (JSON or plain
 * string). Never throws — journal writes must not break a turn. An action
 * outside TASK_EVENT_ACTIONS is still written but console-warned so we notice
 * vocabulary drift.
 */
export function logTaskEvent(
	taskId: string,
	action: string,
	detail?: Record<string, unknown> | string | null
): void {
	try {
		if (!(TASK_EVENT_ACTIONS as readonly string[]).includes(action)) {
			console.warn(`[task-journal] unknown action "${action}" for ${taskId}`);
		}
		const target =
			detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail);
		writeActivity(taskId, action, target);
	} catch (e) {
		console.error('logTaskEvent error:', e);
	}
}

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
 * Existence check for a specific journaled event on a trace — unbounded (a
 * COUNT, not capped to the first N rows like getActivityForTrace). Used by the
 * completion idempotency guard so a late event beyond the row cap can't be
 * missed.
 */
export function hasTaskEvent(traceId: string, action: string): boolean {
	if (!traceId || !fs.existsSync(serverConfig.memoryDbPath)) return false;
	const db = getDb();
	try {
		const row = db
			.prepare('SELECT 1 FROM chat_activity WHERE trace_id = ? AND action = ? LIMIT 1')
			.get(traceId, action) as { 1: number } | undefined;
		return row !== undefined;
	} catch (e: unknown) {
		console.error('hasTaskEvent error:', e);
		return false;
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
