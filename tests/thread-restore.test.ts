// Tests the LOS-178 thread restore order honored by resolveInitialThread():
//   1. URL param (?thread=) if it resolves to a real thread
//   2. else persisted last-active (chat_user_state.last_thread)
//   3. validated to still exist — a deleted thread falls through
//   4. else a fresh thread — ONLY as last resort
//
// Strategy: a temp companion DB (bootstrapped to create chat_messages +
// chat_user_state), seed rows directly, and assert the resolver's output. The
// fresh-id is injected so the resolver stays deterministic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB = path.join(os.tmpdir(), 'sully-thread-restore-test.db');
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

function wipe() {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
}

beforeEach(() => {
	wipe();
	vi.resetModules();
});
afterEach(() => {
	wipe();
});

// Bootstrap the schema, then return the (freshly-evaluated) chat module so it
// reads the mocked DB path.
async function loadChat() {
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	bootstrapCompanionDb();
	return import('$lib/server/chat');
}

describe('resolveInitialThread — restore order (LOS-178)', () => {
	it('step 1: honors ?thread= when it resolves to a real thread', async () => {
		const { addChatMessage, resolveInitialThread } = await loadChat();
		addChatMessage('operator', 'hi', null, null, null, 'sent', 'thread-real');

		const r = resolveInitialThread('thread-real', 'fresh-xyz');
		expect(r.thread).toBe('thread-real');
		expect(r.deepLinkMiss).toBe(false);
	});

	it('step 1: a ?thread= that does NOT exist does not win — falls through', async () => {
		const { addChatMessage, resolveInitialThread } = await loadChat();
		// A real thread exists but is NOT the requested one, and nothing is persisted.
		addChatMessage('operator', 'hi', null, null, null, 'sent', 'thread-other');

		const r = resolveInitialThread('thread-nope', 'fresh-xyz');
		// No persisted last-active → falls to fresh (NOT to the unrelated real thread,
		// matching the verbatim order — there's no "latest other thread" step).
		expect(r.thread).toBe('fresh-xyz');
	});

	it('step 2/3: a bare open resumes the persisted last-active thread', async () => {
		const { addChatMessage, setActiveThread, resolveInitialThread } = await loadChat();
		addChatMessage('operator', 'hi', null, null, null, 'sent', 'thread-last');
		setActiveThread('thread-last');

		const r = resolveInitialThread(null, 'fresh-xyz');
		expect(r.thread).toBe('thread-last');
		expect(r.deepLinkMiss).toBe(false);
	});

	it('step 3: a DELETED persisted thread falls through to fresh', async () => {
		const { setActiveThread, resolveInitialThread } = await loadChat();
		// last_thread points at a thread with no messages and no meta (deleted).
		setActiveThread('thread-gone');

		const r = resolveInitialThread(null, 'fresh-xyz');
		expect(r.thread).toBe('fresh-xyz');
		expect(r.deepLinkMiss).toBe(false);
	});

	it('step 4: nothing persisted + no ?thread= → fresh as last resort', async () => {
		const { resolveInitialThread } = await loadChat();

		const r = resolveInitialThread(undefined, 'fresh-xyz');
		expect(r.thread).toBe('fresh-xyz');
		expect(r.deepLinkMiss).toBe(false);
	});

	it('deepLinkMiss: requested thread is gone but a real last-active exists → fall back + flag', async () => {
		const { addChatMessage, setActiveThread, resolveInitialThread } = await loadChat();
		addChatMessage('operator', 'hi', null, null, null, 'sent', 'thread-last');
		setActiveThread('thread-last');

		const r = resolveInitialThread('thread-deleted', 'fresh-xyz');
		expect(r.thread).toBe('thread-last');
		// A thread WAS requested but couldn't be honored, and we have a real thread
		// to show → signal the plain-English fallback (never a blank screen).
		expect(r.deepLinkMiss).toBe(true);
	});

	it('deepLinkMiss stays false when the fall-through lands on a fresh thread', async () => {
		const { resolveInitialThread } = await loadChat();
		// Requested thread is gone AND nothing real to resume → fresh, no toast.
		const r = resolveInitialThread('thread-deleted', 'fresh-xyz');
		expect(r.thread).toBe('fresh-xyz');
		expect(r.deepLinkMiss).toBe(false);
	});
});

describe('threadExists (LOS-178)', () => {
	it('counts a message-bearing thread as real', async () => {
		const { addChatMessage, threadExists } = await loadChat();
		addChatMessage('operator', 'hi', null, null, null, 'sent', 'has-msgs');
		expect(threadExists('has-msgs')).toBe(true);
		expect(threadExists('never-existed')).toBe(false);
	});

	it('counts a meta-only thread (renamed empty thread) as real', async () => {
		const { threadExists } = await loadChat();
		const db = new Database(DB);
		db.exec(
			`CREATE TABLE IF NOT EXISTS chat_thread_meta (
				thread_id TEXT PRIMARY KEY,
				title TEXT NOT NULL DEFAULT 'New thread',
				pinned BOOLEAN NOT NULL DEFAULT 0,
				archived BOOLEAN NOT NULL DEFAULT 0,
				summary TEXT NULL,
				remember_flag BOOLEAN NOT NULL DEFAULT 0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)`
		);
		db.prepare(
			"INSERT INTO chat_thread_meta (thread_id, title) VALUES ('meta-only', 'Renamed')"
		).run();
		db.close();

		expect(threadExists('meta-only')).toBe(true);
	});

	it('returns false for the empty string', async () => {
		const { threadExists } = await loadChat();
		expect(threadExists('')).toBe(false);
	});
});
