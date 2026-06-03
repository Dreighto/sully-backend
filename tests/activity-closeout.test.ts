import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-activity-closeout-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DISPATCH_ENABLED: 'true'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

describe('resolveCompletionThread', () => {
	it('treats an empty-string thread_id as missing → default', async () => {
		const { resolveCompletionThread } = await import('$lib/server/completionClose');
		expect(resolveCompletionThread('')).toBe('default');
		expect(resolveCompletionThread(null)).toBe('default');
		expect(resolveCompletionThread('thread-42')).toBe('thread-42');
	});
});

describe('closeOutTask race', () => {
	it('still posts the result when the job is already aborted (completed-after-abort)', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { closeOutTask } = await import('$lib/server/completionClose');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		j.createJob({
			traceId: 'sully-r1',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0,
			threadId: 'thread-9'
		});
		j.markAborted('sully-r1'); // job is terminal BEFORE the late callback
		closeOutTask('sully-r1', 'done', 'all done, PR #5 merged');
		const { getChatMessages } = await import('$lib/server/chat');
		const msgs = getChatMessages(50, 'thread-9');
		expect(msgs.some((m) => m.message.includes('all done, PR #5 merged'))).toBe(true);
	});

	it('is idempotent — a duplicate terminal callback does not double-post', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { closeOutTask } = await import('$lib/server/completionClose');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		const { getChatMessages } = await import('$lib/server/chat');
		bootstrapCompanionDb();
		j.createJob({
			traceId: 'sully-dup',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0,
			threadId: 'thread-dup'
		});
		j.markDispatched('sully-dup');
		j.markDone('sully-dup', 'result one');
		// First close-out (normal done→synthesized path).
		closeOutTask('sully-dup', 'done', 'result one');
		// A retried/duplicate callback must NOT post a second message.
		closeOutTask('sully-dup', 'done', 'result one');
		const posts = getChatMessages(50, 'thread-dup').filter((m) => m.message.includes('result one'));
		expect(posts).toHaveLength(1);
	});

	it('is idempotent on the aborted path too (completed-after-abort, then a retry)', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { closeOutTask } = await import('$lib/server/completionClose');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		const { getChatMessages } = await import('$lib/server/chat');
		bootstrapCompanionDb();
		j.createJob({
			traceId: 'sully-ab',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0,
			threadId: 'thread-ab'
		});
		j.markAborted('sully-ab');
		closeOutTask('sully-ab', 'done', 'late result'); // posts (markSynthesized can't flip aborted)
		closeOutTask('sully-ab', 'done', 'late result'); // duplicate must not re-post
		const posts = getChatMessages(50, 'thread-ab').filter((m) => m.message.includes('late result'));
		expect(posts).toHaveLength(1);
	});
});
