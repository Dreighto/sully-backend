import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

function getDb(): Database.Database {
	const db = new Database(serverConfig.memoryDbPath);
	db.prepare(
		`CREATE TABLE IF NOT EXISTS chat_drafts (
			thread_id TEXT PRIMARY KEY,
			body TEXT NOT NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`
	).run();
	return db;
}

export function getDraft(threadId: string): string {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return '';
	const db = getDb();
	try {
		const row = db.prepare('SELECT body FROM chat_drafts WHERE thread_id = ?').get(threadId) as
			| { body?: string }
			| undefined;
		return row?.body ?? '';
	} catch (e) {
		console.error('getDraft error:', e);
		return '';
	} finally {
		db.close();
	}
}

export function saveDraft(threadId: string, text: string): void {
	const db = getDb();
	try {
		if (text.trim()) {
			db.prepare(
				`INSERT INTO chat_drafts (thread_id, body, updated_at)
				 VALUES (?, ?, CURRENT_TIMESTAMP)
				 ON CONFLICT(thread_id) DO UPDATE SET body = excluded.body, updated_at = CURRENT_TIMESTAMP`
			).run(threadId, text);
		} else {
			db.prepare('DELETE FROM chat_drafts WHERE thread_id = ?').run(threadId);
		}
	} catch (e) {
		console.error('saveDraft error:', e);
	} finally {
		db.close();
	}
}
