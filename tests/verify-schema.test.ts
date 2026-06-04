import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-verify-schema-test.db';
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

describe('verification_evidence column + markVerified', () => {
	it('stores the matrix JSON on the job row and flips done→verified', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		const j = await import('$lib/server/dispatchJobs');
		bootstrapCompanionDb();
		j.createJob({
			traceId: 's1',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'f',
			predictedTokens: 0
		});
		j.markDispatched('s1');
		j.markDone('s1', 'ok');
		j.markVerified('s1', 'confirmed', null, '{"overall":"GO"}');
		const job = j.getJob('s1')!;
		expect(job.status).toBe('verified');
		expect(job.verification_state).toBe('confirmed');
		expect(job.verification_evidence).toContain('"overall":"GO"');
	});
});
