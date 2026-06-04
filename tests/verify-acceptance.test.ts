import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-verify-accept-test.db';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: DB,
		COMPANION_DISPATCH_ENABLED: 'true'
	}
}));
const synth = vi.fn(async () => 'summary');
vi.mock('$lib/server/routing/synthesize', () => ({ synthesizeWorkerResult: synth }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
	synth.mockClear();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

async function seedDone(traceId: string, evidence: object) {
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	const j = await import('$lib/server/dispatchJobs');
	bootstrapCompanionDb();
	j.createJob({
		traceId,
		worker: 'claude-code',
		category: 'code',
		brief: 'run the tests',
		fingerprint: 'f',
		predictedTokens: 0,
		threadId: 't1'
	});
	j.markDispatched(traceId);
	j.markDone(traceId, 'All tests passed');
	return { evidence };
}

describe('acceptance #5 — UNKNOWN is never stated as fact', () => {
	it('a "tests passed" claim with no checkable evidence → hedge posture into synthesis', async () => {
		await seedDone('s-unk', {});
		const { closeOutTask } = await import('$lib/server/completionClose');
		await closeOutTask('s-unk', 'done', 'All tests passed', {}); // no evidence pointers
		// FSM channels are GO (liveness) but nothing deliverable is checkable → hedge
		expect(synth).toHaveBeenCalledWith(expect.objectContaining({ posture: 'hedge' }));
		const j = await import('$lib/server/dispatchJobs');
		expect(j.getJob('s-unk')!.verification_state).toBe('hedge');
	});

	it('a contradicted artifact claim → warn posture + needs_review journaled', async () => {
		await seedDone('s-no', {});
		const { closeOutTask } = await import('$lib/server/completionClose');
		await closeOutTask('s-no', 'done', 'Wrote the file', {
			fs_paths: ['/tmp/definitely-not-here.xyz']
		});
		expect(synth).toHaveBeenCalledWith(expect.objectContaining({ posture: 'warn' }));
		const { getActivityForTrace } = await import('$lib/server/chatActivity');
		const poll = getActivityForTrace('s-no', 50).find((a) => a.action === 'verification_poll');
		expect(poll && JSON.parse(poll.target!).needs_review).toBe(true);
	});
});
