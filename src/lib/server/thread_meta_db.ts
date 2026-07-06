// Shared DB bootstrap + row shape for chat_thread_meta. Split out (Wave 2,
// 2026-07-06) so thread_meta.ts / thread_trash.ts / thread_delete_cascade.ts
// share exactly one ensureTable/ensuredPaths — duplicating the migration
// guard across files would just re-run redundant idempotent DDL per file per
// process, not corrupt anything, but there's no reason to.

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
	/** ISO timestamp the thread was soft-deleted (moved to Recently Deleted), else null. */
	deleted_at: string | null;
}

const ensuredPaths = new Set<string>();

export function ensureTable(db: Database.Database): void {
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

export function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

export function dbExists(): boolean {
	return fs.existsSync(serverConfig.memoryDbPath);
}

export function rowToMeta(row: any): ThreadMeta {
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
