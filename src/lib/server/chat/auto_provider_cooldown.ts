// Persistent Auto-mode provider cooldowns. When Anthropic (or another lane) hits
// rate limit / overload / cap, Auto skips that family on subsequent turns until
// the cooldown expires — then primary is tried again without picker changes.

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from '$lib/server/config';
import type { SullyErrorCode } from '$lib/server/chat/sdk_direct_reply';
import { isAnthropicCapExceeded } from '$lib/server/chat/sdk_direct_reply';

export type AutoProviderFamily = 'anthropic' | 'google' | 'local';

type CooldownRow = {
	provider: string;
	cooled_until_ms: number;
	reason: string;
};

const ensuredPaths = new Set<string>();

function ensureTables(db: Database.Database): void {
	const key = serverConfig.memoryDbPath;
	if (ensuredPaths.has(key)) return;
	db.exec(`
		CREATE TABLE IF NOT EXISTS auto_provider_cooldown (
			provider TEXT PRIMARY KEY,
			cooled_until_ms INTEGER NOT NULL,
			reason TEXT NOT NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
	`);
	ensuredPaths.add(key);
}

function getDb(): Database.Database {
	return new Database(serverConfig.memoryDbPath);
}

function dbExists(): boolean {
	return fs.existsSync(serverConfig.memoryDbPath);
}

function envMs(key: string, fallback: number): number {
	const raw = process.env[key];
	if (raw === undefined || raw === '') return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function cooldownMsFor(code: SullyErrorCode, family: AutoProviderFamily): number {
	if (code === 'rate_limit') {
		if (family === 'anthropic') {
			return envMs('SULLY_AUTO_ANTHROPIC_RATE_LIMIT_COOLDOWN_MS', 6 * 60 * 60 * 1000);
		}
		return envMs('SULLY_AUTO_COOLDOWN_RATE_LIMIT_MS', 60 * 60 * 1000);
	}
	if (code === 'credential_unavailable') {
		return envMs('SULLY_AUTO_COOLDOWN_CREDENTIAL_MS', 24 * 60 * 60 * 1000);
	}
	if (code === 'provider_error') {
		return envMs('SULLY_AUTO_COOLDOWN_PROVIDER_ERROR_MS', 15 * 60 * 1000);
	}
	if (code === 'timeout') {
		return envMs('SULLY_AUTO_COOLDOWN_TIMEOUT_MS', 5 * 60 * 1000);
	}
	return envMs('SULLY_AUTO_COOLDOWN_DEFAULT_MS', 15 * 60 * 1000);
}

function endOfUtcDayMs(now = Date.now()): number {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function providerFamilyFromApi(provider: string | undefined): AutoProviderFamily | null {
	if (provider === 'anthropic') return 'anthropic';
	if (provider === 'google') return 'google';
	if (provider === 'local') return 'local';
	return null;
}

export function isAutoProviderCooling(family: AutoProviderFamily, now = Date.now()): boolean {
	if (family === 'anthropic' && isAnthropicCapExceeded()) return true;
	if (!dbExists()) return false;
	const db = getDb();
	try {
		ensureTables(db);
		const row = db
			.prepare('SELECT cooled_until_ms FROM auto_provider_cooldown WHERE provider = ?')
			.get(family) as { cooled_until_ms: number } | undefined;
		return Boolean(row && row.cooled_until_ms > now);
	} catch {
		return false;
	} finally {
		db.close();
	}
}

export function getAutoProviderCooldown(
	family: AutoProviderFamily
): { cooledUntilMs: number; reason: string } | null {
	if (!dbExists()) return null;
	const db = getDb();
	try {
		ensureTables(db);
		const row = db
			.prepare('SELECT cooled_until_ms, reason FROM auto_provider_cooldown WHERE provider = ?')
			.get(family) as CooldownRow | undefined;
		if (!row || row.cooled_until_ms <= Date.now()) return null;
		return { cooledUntilMs: row.cooled_until_ms, reason: row.reason };
	} catch {
		return null;
	} finally {
		db.close();
	}
}

export function recordAutoProviderFailure(
	family: AutoProviderFamily,
	code: SullyErrorCode,
	detail?: string
): void {
	if (!dbExists()) return;
	const now = Date.now();
	let until = now + cooldownMsFor(code, family);
	if (family === 'anthropic' && isAnthropicCapExceeded()) {
		until = Math.max(until, endOfUtcDayMs(now));
	}
	const reason = detail ? `${code}:${detail.slice(0, 120)}` : code;
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare(
			`
			INSERT INTO auto_provider_cooldown (provider, cooled_until_ms, reason, updated_at)
			VALUES (?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(provider) DO UPDATE SET
				cooled_until_ms = MAX(excluded.cooled_until_ms, auto_provider_cooldown.cooled_until_ms),
				reason = excluded.reason,
				updated_at = CURRENT_TIMESTAMP
		`
		).run(family, until, reason);
	} catch (e) {
		console.error('[auto] recordAutoProviderFailure error:', e);
	} finally {
		db.close();
	}
}

/** Primary lane recovered — allow Auto to prefer it again. */
export function recordAutoProviderSuccess(family: AutoProviderFamily): void {
	if (!dbExists()) return;
	const db = getDb();
	try {
		ensureTables(db);
		db.prepare('DELETE FROM auto_provider_cooldown WHERE provider = ?').run(family);
	} catch (e) {
		console.error('[auto] recordAutoProviderSuccess error:', e);
	} finally {
		db.close();
	}
}

/** Sync daily cap exhaustion into the cooldown table (until UTC midnight). */
export function syncAnthropicCapCooldown(): void {
	if (!isAnthropicCapExceeded()) return;
	recordAutoProviderFailure('anthropic', 'rate_limit', 'anthropic daily token cap');
}
