// Locks getChatMessagesSince (thread-fetch delta short-circuit, Tier-1
// detached recovery): rows id > since ascending, thread-scoped, with
// {latest_id, thread_updated} meta so a stale client window can cheaply
// confirm it is caught up. Real-DB roundtrip via bootstrapCompanionDb.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const DB = '/tmp/sully-delta-fetch-test.db';
const ENV = {
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

function wipeDb() {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
}

beforeEach(() => {
	wipeDb();
	vi.resetModules();
});
afterEach(() => {
	wipeDb();
});

async function seed() {
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	bootstrapCompanionDb();
	const { addChatMessage } = await import('$lib/server/chat');
	const a = addChatMessage('operator', 'first', null, null, null, 'sent', 'thread-a');
	const b = addChatMessage('cc', 'second', null, null, null, 'sent', 'thread-a');
	const c = addChatMessage('operator', 'third', null, null, null, 'sent', 'thread-a');
	const other = addChatMessage('operator', 'other thread', null, null, null, 'sent', 'thread-b');
	return { a, b, c, other };
}

describe('getChatMessagesSince', () => {
	it('returns the full thread from since=0 with latest_id + thread_updated meta', async () => {
		const { a, b, c } = await seed();
		const { getChatMessagesSince } = await import('$lib/server/chat');
		const delta = getChatMessagesSince(0, 'thread-a');
		expect(delta.messages.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
		expect(delta.latest_id).toBe(c.id);
		expect(delta.thread_updated).toBe(c.timestamp);
	});

	it('returns only rows newer than since, ascending', async () => {
		const { a, b, c } = await seed();
		const { getChatMessagesSince } = await import('$lib/server/chat');
		const delta = getChatMessagesSince(a.id, 'thread-a');
		expect(delta.messages.map((m) => m.id)).toEqual([b.id, c.id]);
		expect(delta.latest_id).toBe(c.id);
	});

	it('returns an empty delta but live meta when the client is caught up', async () => {
		const { c } = await seed();
		const { getChatMessagesSince } = await import('$lib/server/chat');
		const delta = getChatMessagesSince(c.id, 'thread-a');
		expect(delta.messages).toEqual([]);
		expect(delta.latest_id).toBe(c.id);
		expect(delta.thread_updated).toBe(c.timestamp);
	});

	it('is thread-scoped: another thread’s rows never leak into the delta or meta', async () => {
		const { other } = await seed();
		const { getChatMessagesSince } = await import('$lib/server/chat');
		const delta = getChatMessagesSince(0, 'thread-b');
		expect(delta.messages.map((m) => m.id)).toEqual([other.id]);
		expect(delta.latest_id).toBe(other.id);
	});

	it('returns {[], 0, null} for an empty/unknown thread', async () => {
		await seed();
		const { getChatMessagesSince } = await import('$lib/server/chat');
		const delta = getChatMessagesSince(0, 'no-such-thread');
		expect(delta).toEqual({ messages: [], latest_id: 0, thread_updated: null });
	});

	it('caps the delta to the OLDEST `limit` rows so the client can page forward', async () => {
		const { a, b, c } = await seed();
		const { getChatMessagesSince } = await import('$lib/server/chat');
		const page1 = getChatMessagesSince(0, 'thread-a', 2);
		expect(page1.messages.map((m) => m.id)).toEqual([a.id, b.id]);
		// latest_id still points at the true head, so the client knows more remain.
		expect(page1.latest_id).toBe(c.id);
		const page2 = getChatMessagesSince(b.id, 'thread-a', 2);
		expect(page2.messages.map((m) => m.id)).toEqual([c.id]);
	});

	it('returns {[], 0, null} when the DB file does not exist yet', async () => {
		// No bootstrap — the module must not throw on a missing DB.
		const { getChatMessagesSince } = await import('$lib/server/chat');
		expect(getChatMessagesSince(0, 'default')).toEqual({
			messages: [],
			latest_id: 0,
			thread_updated: null
		});
	});
});
