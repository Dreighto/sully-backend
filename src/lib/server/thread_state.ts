// Server-side persistence for chat thread tier state and per-provider
// daily token usage.
//
// Two tables in logueos_memory.db:
//   chat_thread_state  — tier + operator override per thread
//   chat_token_usage   — rolling daily token counts per provider
//
// Both are created lazily on first write so existing DB files don't
// need a migration script.

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';
import type { Tier } from './phase_classifier';

export type { Tier };

export type ProviderPreference = 'anthropic' | 'gemini' | 'local' | null;

export interface ThreadState {
	thread_id: string;
	current_tier: Tier;
	operator_override: string | null;
	provider_override: ProviderPreference;
	last_model_used: string | null;
	updated_at: string;
}

// Per-path table creation guard. CREATE TABLE IF NOT EXISTS is fast
// but we avoid redundant calls by caching per-DB path.
const ensuredPaths = new Set<string>();

function ensureTables(db: Database.Database): void {
	const key = serverConfig.memoryDbPath;
	if (ensuredPaths.has(key)) return;
	db.exec(`
		CREATE TABLE IF NOT EXISTS chat_thread_state (
			thread_id TEXT PRIMARY KEY,
			current_tier TEXT NOT NULL DEFAULT 'chat',
			operator_override TEXT NULL,
			last_model_used TEXT NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS chat_token_usage (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			date TEXT NOT NULL,
			provider TEXT NOT NULL,
			tokens_used INTEGER NOT NULL DEFAULT 0,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(date, provider)
		);
	`);
	// Idempotent column add for provider_override — older DBs predate this
	// column. SQLite ALTER TABLE ADD COLUMN throws if the column already
	// exists; swallow that one specific error.
	try {
		db.exec(`ALTER TABLE chat_thread_state ADD COLUMN provider_override TEXT NULL`);
	} catch (e) {
		if (!(e instanceof Error && /duplicate column/i.test(e.message))) throw e;
	}
	ensuredPaths.add(key);
}

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

function dbExists(): boolean {
	return fs.existsSync(serverConfig.memoryDbPath);
}

export function getThreadState(threadId: string): ThreadState {
	if (!dbExists()) {
		return {
			thread_id: threadId,
			current_tier: 'chat',
			operator_override: null,
			provider_override: null,
			last_model_used: null,
			updated_at: ''
		};
	}
	const db = getDb();
	try {
		ensureTables(db);
		const row = db.prepare('SELECT * FROM chat_thread_state WHERE thread_id = ?').get(threadId) as
			| ThreadState
			| undefined;
		return (
			row ?? {
				thread_id: threadId,
				current_tier: 'chat',
				operator_override: null,
				provider_override: null,
				last_model_used: null,
				updated_at: ''
			}
		);
	} catch {
		return {
			thread_id: threadId,
			current_tier: 'chat',
			operator_override: null,
			provider_override: null,
			last_model_used: null,
			updated_at: ''
		};
	} finally {
		db.close();
	}
}

export function upsertThreadTier(threadId: string, tier: Tier, modelUsed?: string | null): void {
	if (!dbExists()) return;
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare(
			`
			INSERT INTO chat_thread_state (thread_id, current_tier, last_model_used, updated_at)
			VALUES (?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(thread_id) DO UPDATE SET
				current_tier = excluded.current_tier,
				last_model_used = COALESCE(excluded.last_model_used, last_model_used),
				updated_at = CURRENT_TIMESTAMP
		`
		).run(threadId, tier, modelUsed ?? null);
	} catch (e) {
		console.error('upsertThreadTier error:', e);
	} finally {
		db.close();
	}
}

export function setOperatorOverride(threadId: string, override: Tier | null): void {
	if (!dbExists()) return;
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare(
			`
			INSERT INTO chat_thread_state (thread_id, current_tier, operator_override, updated_at)
			VALUES (?, COALESCE((SELECT current_tier FROM chat_thread_state WHERE thread_id = ?), 'chat'), ?, CURRENT_TIMESTAMP)
			ON CONFLICT(thread_id) DO UPDATE SET
				operator_override = excluded.operator_override,
				updated_at = CURRENT_TIMESTAMP
		`
		).run(threadId, threadId, override);
	} catch (e) {
		console.error('setOperatorOverride error:', e);
	} finally {
		db.close();
	}
}

export function setProviderOverride(threadId: string, provider: ProviderPreference): void {
	if (!dbExists()) return;
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare(
			`
			INSERT INTO chat_thread_state (thread_id, current_tier, provider_override, updated_at)
			VALUES (?, COALESCE((SELECT current_tier FROM chat_thread_state WHERE thread_id = ?), 'chat'), ?, CURRENT_TIMESTAMP)
			ON CONFLICT(thread_id) DO UPDATE SET
				provider_override = excluded.provider_override,
				updated_at = CURRENT_TIMESTAMP
		`
		).run(threadId, threadId, provider);
	} catch (e) {
		console.error('setProviderOverride error:', e);
	} finally {
		db.close();
	}
}

export function getTodayTokenUsage(): Record<string, number> {
	if (!dbExists()) return {};
	const today = todayDate();
	const db = getDb();
	try {
		ensureTables(db);
		const rows = db
			.prepare('SELECT provider, tokens_used FROM chat_token_usage WHERE date = ?')
			.all(today) as Array<{ provider: string; tokens_used: number }>;
		const result: Record<string, number> = {};
		for (const row of rows) {
			result[row.provider] = row.tokens_used;
		}
		return result;
	} catch {
		return {};
	} finally {
		db.close();
	}
}

export function getTokenUsage(provider: string): number {
	if (!dbExists()) return 0;
	const today = todayDate();
	const db = getDb();
	try {
		ensureTables(db);
		const row = db
			.prepare('SELECT tokens_used FROM chat_token_usage WHERE date = ? AND provider = ?')
			.get(today, provider) as { tokens_used: number } | undefined;
		return row?.tokens_used ?? 0;
	} catch {
		return 0;
	} finally {
		db.close();
	}
}

export function addTokenUsage(provider: string, tokens: number): void {
	if (tokens <= 0 || !dbExists()) return;
	const today = todayDate();
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare(
			`
			INSERT INTO chat_token_usage (date, provider, tokens_used)
			VALUES (?, ?, ?)
			ON CONFLICT(date, provider) DO UPDATE SET
				tokens_used = tokens_used + excluded.tokens_used,
				updated_at = CURRENT_TIMESTAMP
		`
		).run(today, provider, tokens);
	} catch (e) {
		console.error('addTokenUsage error:', e);
	} finally {
		db.close();
	}
}

function todayDate(): string {
	return new Date().toISOString().slice(0, 10);
}
