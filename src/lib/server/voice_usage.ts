// Voice usage tracking for daily caps.
// Two tables in logueos_memory.db:
//   chat_stt_usage — daily AssemblyAI STT minutes consumed
//   chat_tts_usage — daily ElevenLabs TTS characters consumed
//
// Tables created lazily on first write; no migration script required.

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

const ensuredPaths = new Set<string>();

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

function ensureTables(db: Database.Database): void {
	const key = serverConfig.memoryDbPath;
	if (ensuredPaths.has(key)) return;
	db.exec(`
		CREATE TABLE IF NOT EXISTS chat_stt_usage (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			date TEXT NOT NULL,
			minutes_used REAL NOT NULL DEFAULT 0,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(date)
		);
		CREATE TABLE IF NOT EXISTS chat_tts_usage (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			date TEXT NOT NULL,
			chars_used INTEGER NOT NULL DEFAULT 0,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(date)
		);
	`);
	ensuredPaths.add(key);
}

function todayDate(): string {
	return new Date().toISOString().slice(0, 10);
}

export function getTodaySttUsage(): number {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return 0;
	const db = getDb();
	try {
		ensureTables(db);
		const row = db
			.prepare('SELECT minutes_used FROM chat_stt_usage WHERE date = ?')
			.get(todayDate()) as { minutes_used: number } | undefined;
		return row?.minutes_used ?? 0;
	} finally {
		db.close();
	}
}

export function addSttUsage(minutes: number): void {
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare(`
			INSERT INTO chat_stt_usage (date, minutes_used) VALUES (?, ?)
			ON CONFLICT(date) DO UPDATE SET
				minutes_used = minutes_used + excluded.minutes_used,
				updated_at = CURRENT_TIMESTAMP
		`).run(todayDate(), minutes);
	} finally {
		db.close();
	}
}

export function getTodayTtsUsage(): number {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return 0;
	const db = getDb();
	try {
		ensureTables(db);
		const row = db
			.prepare('SELECT chars_used FROM chat_tts_usage WHERE date = ?')
			.get(todayDate()) as { chars_used: number } | undefined;
		return row?.chars_used ?? 0;
	} finally {
		db.close();
	}
}

export function addTtsUsage(chars: number): void {
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare(`
			INSERT INTO chat_tts_usage (date, chars_used) VALUES (?, ?)
			ON CONFLICT(date) DO UPDATE SET
				chars_used = chars_used + excluded.chars_used,
				updated_at = CURRENT_TIMESTAMP
		`).run(todayDate(), chars);
	} finally {
		db.close();
	}
}
