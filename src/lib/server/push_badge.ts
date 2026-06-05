// Badge counter for the APNs "unseen finished tasks" count.
//
// A single row in chat_push_badge tracks how many completed tasks the
// operator hasn't yet looked at. Incremented each time a completion push
// is sent (one per task); cleared (to 0) when the operator opens the app
// (PUT /api/chat/push/badge-clear) or when any task thread is opened.
//
// Self-creating table (CREATE TABLE IF NOT EXISTS) — no migration needed.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import { serverConfig } from './config';

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

function ensureTable(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS chat_push_badge (
			key  TEXT PRIMARY KEY DEFAULT 'singleton',
			count INTEGER NOT NULL DEFAULT 0
		);
		INSERT OR IGNORE INTO chat_push_badge (key, count) VALUES ('singleton', 0);
	`);
}

/** Increment the badge by 1 and return the new count. */
export function incrementBadge(): number {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return 1;
	const db = getDb();
	try {
		ensureTable(db);
		db.prepare(`UPDATE chat_push_badge SET count = count + 1 WHERE key = 'singleton'`).run();
		const row = db.prepare(`SELECT count FROM chat_push_badge WHERE key = 'singleton'`).get() as
			| { count: number }
			| undefined;
		return row?.count ?? 1;
	} catch (e) {
		console.error('[push_badge] incrementBadge error:', e);
		return 1;
	} finally {
		db.close();
	}
}

/** Clear the badge (set to 0) and return 0. */
export function clearBadge(): void {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return;
	const db = getDb();
	try {
		ensureTable(db);
		db.prepare(`UPDATE chat_push_badge SET count = 0 WHERE key = 'singleton'`).run();
	} catch (e) {
		console.error('[push_badge] clearBadge error:', e);
	} finally {
		db.close();
	}
}

/** Read the current badge count (0 if unset). */
export function getBadgeCount(): number {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return 0;
	const db = getDb();
	try {
		ensureTable(db);
		const row = db.prepare(`SELECT count FROM chat_push_badge WHERE key = 'singleton'`).get() as
			| { count: number }
			| undefined;
		return row?.count ?? 0;
	} catch (e) {
		console.error('[push_badge] getBadgeCount error:', e);
		return 0;
	} finally {
		db.close();
	}
}
