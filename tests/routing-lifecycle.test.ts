import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-routing-lifecycle-test.db';
const ENV = { LOGUEOS_APP_MODE: 'companion', LOGUEOS_MEMORY_DB_PATH: DB };
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

describe('markClassified', () => {
	it('writes the tier onto the proposed Task row and advances it to classified', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.proposeTask({
			taskId: 'sully-c1',
			threadId: 't1',
			source: 'chat',
			category: 'general',
			brief: 'hi'
		});
		j.markClassified('sully-c1', 'planning', JSON.stringify({ reason: 'phrase' }));
		const row = j.getJob('sully-c1');
		expect(row?.status).toBe('classified');
		expect(row?.classification_tier).toBe('planning');
	});

	it('is idempotent — a second call just refreshes the tier, never throws', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.proposeTask({
			taskId: 'sully-c2',
			threadId: 't1',
			source: 'chat',
			category: 'general',
			brief: 'hi'
		});
		j.markClassified('sully-c2', 'chat', null);
		expect(() => j.markClassified('sully-c2', 'deep', null)).not.toThrow();
		expect(j.getJob('sully-c2')?.classification_tier).toBe('deep');
	});
});

describe('markSelfHandled', () => {
	it('links the latest reply + synthesizes a proposed/classified self-handled turn', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		const { addChatMessage } = await import('$lib/server/chat');
		bootstrapCompanionDb();
		j.proposeTask({
			taskId: 'sully-s1',
			threadId: 't1',
			source: 'chat',
			category: 'general',
			brief: 'hey'
		});
		j.markClassified('sully-s1', 'chat', null);
		const reply = addChatMessage('local', 'hi there', 'sully-s1', null, null, 'sent', 't1', {
			taskId: 'sully-s1'
		});
		j.markSelfHandled('sully-s1');
		const row = j.getJob('sully-s1');
		expect(row?.status).toBe('synthesized');
		expect(row?.synthesis_message_id).toBe(reply.id);
	});

	it('leaves an already-dispatched job alone (no clobber)', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.createJob({
			traceId: 'sully-s2',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0,
			threadId: 't1'
		});
		j.markDispatched('sully-s2');
		j.markSelfHandled('sully-s2'); // must be a no-op — status is 'dispatched'
		expect(j.getJob('sully-s2')?.status).toBe('dispatched');
	});
});

describe('reapStaleJobs', () => {
	it('fails a job stuck in dispatched/working past the timeout and returns it', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.createJob({
			traceId: 'sully-old',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0,
			threadId: 't1'
		});
		j.markDispatched('sully-old');
		// Backdate started_at to long ago so it trips the timeout.
		const db = new Database(DB);
		db.prepare("UPDATE pending_jobs SET started_at = ? WHERE trace_id = 'sully-old'").run(
			'2000-01-01T00:00:00.000Z'
		);
		db.close();
		const reaped = j.reapStaleJobs(60_000);
		expect(reaped.map((r) => r.trace_id)).toContain('sully-old');
		expect(j.getJob('sully-old')?.status).toBe('failed');
	});

	it('leaves a fresh in-flight job alone', async () => {
		const j = await import('$lib/server/dispatchJobs');
		j.createJob({
			traceId: 'sully-fresh',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'g',
			predictedTokens: 0,
			threadId: 't1'
		});
		j.markDispatched('sully-fresh');
		expect(j.reapStaleJobs(60_000).map((r) => r.trace_id)).not.toContain('sully-fresh');
		expect(j.getJob('sully-fresh')?.status).toBe('dispatched');
	});
});
