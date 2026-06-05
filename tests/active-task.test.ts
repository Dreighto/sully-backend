import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
const DB = '/tmp/sully-active-task-test.db';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: DB,
		COMPANION_DISPATCH_ENABLED: 'true'
	}
}));
beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

describe('getActiveTaskForThread + state sets', () => {
	it('returns the most recent non-terminal task on the thread, null when none/terminal', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		expect(j.getActiveTaskForThread('t1')).toBeNull();
		j.createJob({
			traceId: 'a1',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0,
			threadId: 't1'
		});
		j.markDispatched('a1');
		expect(j.getActiveTaskForThread('t1')?.trace_id).toBe('a1'); // 'dispatched' is active
		expect(j.getActiveTaskForThread('t2')).toBeNull(); // other thread unaffected
		j.markDone('a1', 'r');
		j.markSynthesized('a1', 1);
		expect(j.getActiveTaskForThread('t1')).toBeNull(); // synthesized = terminal
	});
	it('PRE_DISPATCH_STATES / RUNNING_STATES partition the active states', async () => {
		const { PRE_DISPATCH_STATES, RUNNING_STATES } = await import('$lib/server/dispatchJobs');
		for (const s of ['proposed', 'classified', 'gated', 'held'])
			expect(PRE_DISPATCH_STATES.has(s as never)).toBe(true);
		for (const s of ['decided', 'dispatched', 'working', 'retry'])
			expect(RUNNING_STATES.has(s as never)).toBe(true);
		// disjoint
		for (const s of PRE_DISPATCH_STATES) expect(RUNNING_STATES.has(s)).toBe(false);
	});
});
