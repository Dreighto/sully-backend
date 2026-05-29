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
				thread_id TEXT NOT NULL DEFAULT 'default'
			);
			CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
			CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_messages(thread_id, timestamp);
			CREATE TABLE IF NOT EXISTS chat_user_state (
				user_id TEXT PRIMARY KEY DEFAULT 'operator',
				last_thread TEXT NOT NULL DEFAULT 'default',
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			);
		`);
	} finally {
		db.close();
	}
	bootstrapped = true;
}
