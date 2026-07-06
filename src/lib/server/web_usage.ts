// Web-search spend tracking for the daily budget cap. Stored in cents (REAL),
// keyed by date — mirrors the chat_stt_usage / chat_tts_usage pattern in
// voice_usage.ts. Table self-creates on first write.
//
// Perplexity sonar pricing (2026):
//   $5 / 1,000 requests = $0.005/request = 0.5¢/request
//   $1 / 1,000,000 input tokens  = 0.0001¢/token
//   $1 / 1,000,000 output tokens = 0.0001¢/token
//
// The pre-call check uses the request-fee floor (we don't know token counts
// yet); the post-call record adds the actual tokens billed.

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

let ensured = false;

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

function ensure(db: Database.Database): void {
	if (ensured) return;
	db.exec(`
		CREATE TABLE IF NOT EXISTS chat_web_usage (
			date TEXT PRIMARY KEY,
			cents_spent REAL NOT NULL DEFAULT 0,
			requests INTEGER NOT NULL DEFAULT 0,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
	`);
	ensured = true;
}

function todayDate(): string {
	return new Date().toISOString().slice(0, 10);
}

export const SONAR_REQUEST_CENTS = 0.5; // $0.005 / request
export const SONAR_INPUT_PER_TOKEN_CENTS = 0.0001; // $1 / M input
export const SONAR_OUTPUT_PER_TOKEN_CENTS = 0.0001; // $1 / M output

/** Cost of a single sonar call given its token counts (cents). */
export function estimateSonarCostCents(inputTokens: number, outputTokens: number): number {
	return (
		SONAR_REQUEST_CENTS +
		Math.max(0, inputTokens) * SONAR_INPUT_PER_TOKEN_CENTS +
		Math.max(0, outputTokens) * SONAR_OUTPUT_PER_TOKEN_CENTS
	);
}

export function getTodayWebSpendCents(): number {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return 0;
	const db = getDb();
	try {
		ensure(db);
		const row = db
			.prepare('SELECT cents_spent FROM chat_web_usage WHERE date = ?')
			.get(todayDate()) as { cents_spent: number } | undefined;
		return row?.cents_spent ?? 0;
	} finally {
		db.close();
	}
}

export function addWebSpendCents(cents: number): void {
	if (!Number.isFinite(cents) || cents <= 0) return;
	const db = getDb();
	try {
		ensure(db);
		db.prepare(
			`
			INSERT INTO chat_web_usage (date, cents_spent, requests) VALUES (?, ?, 1)
			ON CONFLICT(date) DO UPDATE SET
				cents_spent = cents_spent + excluded.cents_spent,
				requests = requests + 1,
				updated_at = CURRENT_TIMESTAMP
		`
		).run(todayDate(), cents);
	} finally {
		db.close();
	}
}

/**
 * Daily budget in cents (default $0.50 = 50¢). Operator-tunable via
 * WEB_SEARCH_DAILY_BUDGET_CENTS. A value of 0 or less disables the cap.
 */
export function dailyBudgetCents(): number {
	const raw = Number(process.env.WEB_SEARCH_DAILY_BUDGET_CENTS ?? 50);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * True iff a NEW Perplexity call would push today's spend over the cap.
 * Compares the floor cost (just the request fee, before tokens are known) so
 * we don't admit a call that's already obviously over.
 */
export function wouldExceedBudget(): boolean {
	const cap = dailyBudgetCents();
	if (cap <= 0) return false;
	return getTodayWebSpendCents() + SONAR_REQUEST_CENTS > cap;
}
