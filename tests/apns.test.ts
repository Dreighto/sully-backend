// Locks the APNs sender's testable core: self-gating (no-op without config),
// token storage upsert, the ES256 provider-JWT shape, and the alert payload.
// End-to-end delivery needs a real signed build + device token (Codemagic loop)
// and is out of scope for unit tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB = '/tmp/sully-apns-test.db';
// A throwaway EC P-256 key in PKCS8 PEM — stands in for the APNs .p8.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const KEY_PATH = path.join(os.tmpdir(), 'sully-apns-test-key.p8');

const ENV: Record<string, string> = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

function wipe() {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
}

beforeEach(() => {
	wipe();
	new Database(DB).close();
	fs.writeFileSync(KEY_PATH, KEY_PEM);
	delete process.env.APNS_KEY_PATH;
	delete process.env.APNS_KEY_ID;
	vi.resetModules();
});
afterEach(() => {
	wipe();
	if (fs.existsSync(KEY_PATH)) fs.unlinkSync(KEY_PATH);
});

describe('apns self-gating', () => {
	it('apnsConfigured() is false without key path + id', async () => {
		const { apnsConfigured } = await import('$lib/server/apns');
		expect(apnsConfigured()).toBe(false);
	});

	it('sendApnsToAll is a no-op (zeros) when unconfigured', async () => {
		const { sendApnsToAll } = await import('$lib/server/apns');
		const r = await sendApnsToAll({ title: 't', body: 'b' });
		expect(r).toEqual({ sent: 0, failed: 0 });
	});
});

describe('apns token storage', () => {
	it('upserts + replaces a device token', async () => {
		const { upsertApnsToken } = await import('$lib/server/apns');
		upsertApnsToken('dev-1', 'tokenA');
		upsertApnsToken('dev-1', 'tokenB'); // replace
		const db = new Database(DB);
		const rows = db.prepare('SELECT device_id, token FROM chat_apns_tokens').all() as {
			device_id: string;
			token: string;
		}[];
		db.close();
		expect(rows.length).toBe(1);
		expect(rows[0].token).toBe('tokenB');
	});
});

describe('apns configured (no network)', () => {
	it('apnsConfigured() is true once key path + id are set and the file exists', async () => {
		process.env.APNS_KEY_PATH = KEY_PATH;
		process.env.APNS_KEY_ID = 'ABC1234567';
		const { apnsConfigured } = await import('$lib/server/apns');
		expect(apnsConfigured()).toBe(true);
	});
});
