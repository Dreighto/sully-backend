// Companion DB bootstrap.
//
// Two tables — chat_messages and chat_user_state — are created by the LogueOS
// KERNEL (init_memory_db.py), not by the Console chat code. chat.ts only
// INSERTs/SELECTs them, so a FRESH companion database (companion mode) would
// throw "no such table" on the very first setActiveThread()/addChatMessage().
// (The other ~10 chat tables self-create lazily via CREATE TABLE IF NOT EXISTS
// in their owning modules — these two are the gap.)
//
// This creates exactly those two tables (+ their indexes) using the
// AUTHORITATIVE schema pulled live from logueos_memory.db. It is idempotent
// (CREATE TABLE IF NOT EXISTS), so it is also a harmless no-op against the
// populated shared kernel DB in wired mode — no mode branching needed. Called
// FIRST in hooks.server.ts, before any route can touch the DB.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serverConfig } from './config';

let bootstrapped = false;

export function bootstrapCompanionDb(): void {
	if (bootstrapped) return;
	const dbPath = serverConfig.memoryDbPath;

	// Ensure the data dir exists (fresh companion install has no data/ yet).
	try {
		mkdirSync(dirname(dbPath), { recursive: true });
	} catch {
		/* already exists */
	}

	const db = new Database(dbPath);
	try {
		// Match Console's journaling so the two never fight over the same file in
		// wired mode, and so a fresh companion DB gets WAL like the kernel's.
		db.pragma('journal_mode = WAL');
		db.exec(`
			CREATE TABLE IF NOT EXISTS chat_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				sender TEXT NOT NULL,
				message TEXT NOT NULL,
				trace_id TEXT,
				ticket_id TEXT,
				interactive_action TEXT,
				status TEXT DEFAULT 'sent',
				timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
				thread_id TEXT NOT NULL DEFAULT 'default',
				quality_signal INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
			CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_messages(thread_id, timestamp);
			CREATE TABLE IF NOT EXISTS chat_user_state (
				user_id TEXT PRIMARY KEY DEFAULT 'operator',
				last_thread TEXT NOT NULL DEFAULT 'default',
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			-- Layer 2 (episodic): durable facts extracted from remember-flagged threads.
			CREATE TABLE IF NOT EXISTS episodic_facts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				thread_id TEXT NOT NULL,
				fact TEXT NOT NULL,
				source_message_id INTEGER,
				importance INTEGER DEFAULT 1,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP,
				last_seen_at TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_episodic_thread ON episodic_facts(thread_id);

			-- Layer 3 (semantic): one embedding per fact (JSON float array + model tag).
			CREATE TABLE IF NOT EXISTS episodic_embeddings (
				fact_id INTEGER PRIMARY KEY REFERENCES episodic_facts(id) ON DELETE CASCADE,
				embedding TEXT NOT NULL,
				embed_model TEXT NOT NULL
			);

			-- Per-task event journal (Phase 1 of the task-first architecture).
			-- Previously self-created lazily in chatActivity.ts, which could miss
			-- on a cold DB. Hoisted here so it always exists before the first turn.
			-- Keyed by trace_id (== task_id). action vocabulary is open but
			-- validated on the write path (chatActivity.ts). One row per
			-- significant event in a task's life: classifier_ran, gate_evaluated,
			-- brakes_evaluated, provider_attempted, tool_invoked, worker steps
			-- (reading|edited|ran|thinking|completed|failed), synthesis_*, etc.
			CREATE TABLE IF NOT EXISTS chat_activity (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				trace_id TEXT NOT NULL,
				action TEXT NOT NULL,
				target TEXT,
				timestamp TEXT DEFAULT CURRENT_TIMESTAMP
			);
			CREATE INDEX IF NOT EXISTS idx_chat_activity_trace ON chat_activity(trace_id, timestamp);

			-- Work-context store (SUL-178): embedded summaries of ship log, lane, project memory.
			CREATE TABLE IF NOT EXISTS work_knowledge (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source TEXT NOT NULL,
				source_key TEXT UNIQUE NOT NULL,
				chunk TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				importance INTEGER DEFAULT 1,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			);
			CREATE INDEX IF NOT EXISTS idx_work_knowledge_source ON work_knowledge(source);

			CREATE TABLE IF NOT EXISTS work_knowledge_embeddings (
				chunk_id INTEGER PRIMARY KEY REFERENCES work_knowledge(id) ON DELETE CASCADE,
				embedding TEXT NOT NULL,
				embed_model TEXT NOT NULL
			);
		`);

		// Lightweight in-place migrations for chat_messages — additive columns
		// only. CREATE TABLE IF NOT EXISTS above won't add a column to an
		// existing table, so we sniff schema with PRAGMA table_info and ALTER
		// when needed. Safe in wired mode too: the kernel's logueos_memory.db
		// gets the same additive treatment, which is what we want (the
		// quality_signal column is shared signal across Console + companion).
		const cols = db.pragma('table_info(chat_messages)') as { name: string }[];
		const have = new Set(cols.map((c) => c.name));
		// quality_signal: +1 thumbs-up, -1 thumbs-down, NULL no signal. Drives
		// the explicit positive-feedback corpus for Sully fine-tunes.
		if (!have.has('quality_signal')) {
			db.exec('ALTER TABLE chat_messages ADD COLUMN quality_signal INTEGER');
		}
		// Phase 1 forensic columns. task_id links every row of a turn (operator,
		// assistant, system) to its Task. model/provider/tokens/latency make each
		// assistant turn auditable: "what did turn 638 cost and how long did it
		// take?" was previously unanswerable from the DB. error stamps a short
		// failure string when a model attempt threw. All additive + nullable so
		// pre-migration rows are unaffected and backfill isn't required.
		const messageMigrations: Record<string, string> = {
			task_id: 'TEXT',
			model: 'TEXT',
			provider: 'TEXT',
			prompt_tokens: 'INTEGER',
			completion_tokens: 'INTEGER',
			latency_ms: 'INTEGER',
			error: 'TEXT',
			// Stage 2 (idempotent operator-turn persistence): a client-supplied
			// per-turn id. A retry/regenerate re-POSTs the SAME logical turn with a
			// fresh request id; keying the operator row on (thread_id, client_turn_id)
			// lets the re-POST reuse the original row instead of minting a duplicate.
			// Additive + nullable — absent on every pre-Stage-2 row (and on any turn
			// the client doesn't tag), so existing history is untouched.
			client_turn_id: 'TEXT',
			// WI-7 (durable reasoning): the model's thinking/reasoning trace for an
			// assistant turn, so the "Thought process" disclosure survives a thread
			// reload instead of vanishing the moment the live stream ends. Only ever
			// set on assistant rows whose model emitted reasoning; NULL everywhere
			// else. Additive + nullable — pre-migration history is untouched.
			reasoning: 'TEXT'
		};
		for (const [col, type] of Object.entries(messageMigrations)) {
			if (!have.has(col)) {
				db.exec(`ALTER TABLE chat_messages ADD COLUMN ${col} ${type}`);
			}
		}
		if (!have.has('task_id')) {
			db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_task ON chat_messages(task_id)');
		}
		// Stage 2: enforce ONE operator row per (thread_id, client_turn_id). PARTIAL
		// (operator-only, non-null key) so assistant/system rows AND untagged operator
		// turns stay entirely unconstrained — genuine repeats and every legacy row are
		// free to coexist; only a re-POST carrying the SAME key collapses onto its
		// original row. IF NOT EXISTS keeps it idempotent.
		db.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_client_turn ON chat_messages(thread_id, client_turn_id) WHERE sender = 'operator' AND client_turn_id IS NOT NULL"
		);

		// Phase 1: extend pending_jobs into the unified Task object. The table is
		// created (with the base columns) in dispatchJobs.ts; here we add the
		// Task-lifecycle columns idempotently so a turn can mint a 'proposed' row
		// before any dispatch decision, carry its classification trail, and link
		// to its synthesis message + verification outcome. Guarded by table
		// existence — dispatchJobs.ts's getDb() also creates it, but bootstrap
		// runs first on a cold DB so we create the base shape here too.
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
				fingerprint           TEXT NOT NULL DEFAULT ''
			);
			CREATE INDEX IF NOT EXISTS idx_pending_jobs_status ON pending_jobs(status);
			CREATE INDEX IF NOT EXISTS idx_pending_jobs_fp ON pending_jobs(fingerprint);
		`);
		const jobCols = db.pragma('table_info(pending_jobs)') as { name: string }[];
		const haveJob = new Set(jobCols.map((c) => c.name));
		const jobMigrations: Record<string, string> = {
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
		for (const [col, type] of Object.entries(jobMigrations)) {
			if (!haveJob.has(col)) {
				db.exec(`ALTER TABLE pending_jobs ADD COLUMN ${col} ${type}`);
			}
		}
		if (!haveJob.has('thread_id')) {
			db.exec('CREATE INDEX IF NOT EXISTS idx_pending_jobs_thread ON pending_jobs(thread_id)');
		}
	} finally {
		db.close();
	}
	bootstrapped = true;
}
