import Database from 'better-sqlite3';
import { serverConfig } from '../config';

// The Task-lifecycle columns added in Phase 1. Kept here (not only in
// bootstrap.ts) so dispatchJobs is self-sufficient — a test or a code path that
// touches jobs before bootstrap runs still gets the full schema.
const TASK_COLUMNS: Record<string, string> = {
	thread_id: 'TEXT',
	source: 'TEXT',
	classification_tier: 'TEXT',
	classification_payload: 'TEXT',
	verification_state: 'TEXT',
	verification_ref: 'TEXT',
	verification_evidence: 'TEXT',
	synthesis_message_id: 'INTEGER',
	ticket_id: 'TEXT'
};

// Migration-guard singleton — must live in exactly this one file. Every
// caller across dispatch_jobs/*.ts goes through this getDb(), so the table +
// additive-migration bootstrap runs exactly once per process regardless of
// which split file is entered first.
let _ensured = false;
export function getDb(): Database.Database {
	const db = new Database(serverConfig.memoryDbPath);
	if (!_ensured) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS pending_jobs (
				id                    INTEGER PRIMARY KEY AUTOINCREMENT,
				trace_id              TEXT UNIQUE NOT NULL,
				worker                TEXT NOT NULL,
				status                TEXT NOT NULL DEFAULT 'decided',
				category              TEXT NOT NULL DEFAULT 'general',
				current_activity      TEXT,
				seq_cursor            INTEGER NOT NULL DEFAULT 0,
				started_at            TEXT DEFAULT CURRENT_TIMESTAMP,
				ended_at              TEXT,
				predicted_tokens      INTEGER NOT NULL DEFAULT 0,
				actual_prompt         INTEGER,
				actual_completion     INTEGER,
				actual_cache_read     INTEGER,
				actual_cache_creation INTEGER,
				actual_total          INTEGER,
				result_ref            TEXT,
				brief                 TEXT NOT NULL DEFAULT '',
				fingerprint           TEXT NOT NULL DEFAULT '',
				thread_id             TEXT,
				source                TEXT,
				classification_tier   TEXT,
				classification_payload TEXT,
				verification_state    TEXT,
				verification_ref      TEXT,
				synthesis_message_id  INTEGER,
				ticket_id             TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_pending_jobs_status ON pending_jobs(status);
			CREATE INDEX IF NOT EXISTS idx_pending_jobs_fp ON pending_jobs(fingerprint);
			CREATE INDEX IF NOT EXISTS idx_pending_jobs_thread ON pending_jobs(thread_id);
		`);
		// Additive migration for a table that pre-existed without the Task columns.
		const have = new Set(
			(db.pragma('table_info(pending_jobs)') as { name: string }[]).map((c) => c.name)
		);
		for (const [col, type] of Object.entries(TASK_COLUMNS)) {
			if (!have.has(col)) db.exec(`ALTER TABLE pending_jobs ADD COLUMN ${col} ${type}`);
		}
		_ensured = true;
	}
	return db;
}
