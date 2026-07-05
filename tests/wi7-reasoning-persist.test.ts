import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

// WI-7 (durable reasoning): the model's reasoning/thinking trace must persist to
// chat_messages.reasoning and come back through the history read path, so the
// iOS "Thought process" disclosure survives a thread reload instead of vanishing
// when the live stream ends.
const DB = '/tmp/sully-wi7-reasoning-test.db';
vi.mock('$env/dynamic/private', () => ({
	env: { LOGUEOS_APP_MODE: 'companion', LOGUEOS_MEMORY_DB_PATH: DB }
}));
beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

describe('WI-7 durable reasoning persistence', () => {
	it('migrates a reasoning column onto chat_messages', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const db = new Database(DB, { readonly: true });
		const cols = db.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[];
		db.close();
		expect(cols.some((c) => c.name === 'reasoning')).toBe(true);
	});

	it('persists the reasoning trace and returns it through the history read path', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		const { persistAssistantTurn } = await import('$lib/server/chat_turn');
		const { getChatMessages } = await import('$lib/server/chat');
		bootstrapCompanionDb();

		const trace = 'The user asked 6*7. That is 42. Answer directly.';
		persistAssistantTurn({
			text: '6 × 7 = 42.',
			sender: 'local',
			threadId: 'wi7',
			model: 'gpt-oss:120b-cloud',
			tier: 'chat',
			reasoning: trace
		});

		const rows = getChatMessages(10, 'wi7').filter(
			(m: { sender: string }) => m.sender !== 'operator'
		);
		expect(rows.length).toBe(1);
		expect(rows[0].reasoning).toBe(trace);
	});

	it('stores NULL when the turn emitted no reasoning', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		const { persistAssistantTurn } = await import('$lib/server/chat_turn');
		const { getChatMessages } = await import('$lib/server/chat');
		bootstrapCompanionDb();

		persistAssistantTurn({
			text: 'plain reply, no reasoning',
			sender: 'cc',
			threadId: 'wi7n',
			model: 'claude-sonnet-5',
			tier: 'chat'
		});
		// whitespace-only reasoning must also normalize to null, not an empty string
		persistAssistantTurn({
			text: 'whitespace reasoning reply',
			sender: 'cc',
			threadId: 'wi7n',
			model: 'claude-sonnet-5',
			tier: 'chat',
			reasoning: '   \n  '
		});

		const rows = getChatMessages(10, 'wi7n').filter(
			(m: { sender: string }) => m.sender !== 'operator'
		);
		expect(rows.length).toBe(2);
		expect(rows.every((r: { reasoning: string | null }) => r.reasoning === null)).toBe(true);
	});
});
