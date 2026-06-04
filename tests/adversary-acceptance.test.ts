import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-adv-accept-test.db';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: DB,
		COMPANION_DISPATCH_ENABLED: 'true'
	}
}));
const synth = vi.fn(async () => 'summary');
vi.mock('$lib/server/routing/synthesize', () => ({ synthesizeWorkerResult: synth }));
const adv = vi.fn(async () => ({
	findings: [{ concern: 'may weaken error handling', severity: 'high' }],
	available: true
}));
vi.mock('$lib/server/routing/adversary', async (orig) => {
	const actual = (await orig()) as object;
	return { ...actual, runAdversaryReview: adv };
});

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
	synth.mockClear();
	adv.mockClear();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

async function seed(traceId: string, category: string) {
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	const j = await import('$lib/server/dispatchJobs');
	bootstrapCompanionDb();
	j.createJob({
		traceId,
		worker: 'claude-code',
		category,
		brief: 'do the thing',
		fingerprint: 'f',
		predictedTokens: 0,
		threadId: 't1'
	});
	j.markDispatched(traceId);
	j.markDone(traceId, 'Did the thing');
}

describe('acceptance #6 — adversary concerns are judgment, not facts', () => {
	it('high-stakes (code) → adversary runs; its concern reaches synthesis as a concern + is journaled', async () => {
		await seed('s-adv', 'code');
		const { closeOutTask } = await import('$lib/server/completionClose');
		await closeOutTask('s-adv', 'done', 'Did the thing', { fs_paths: [] });
		expect(adv).toHaveBeenCalledTimes(1);
		expect(synth).toHaveBeenCalledWith(
			expect.objectContaining({ concerns: ['may weaken error handling'] })
		);
		const { getActivityForTrace } = await import('$lib/server/chatActivity');
		expect(getActivityForTrace('s-adv', 50).some((a) => a.action === 'adversary_reviewed')).toBe(
			true
		);
	});
	it('low-stakes (general, no state-change evidence) → adversary is NOT called', async () => {
		await seed('s-low', 'general');
		const { closeOutTask } = await import('$lib/server/completionClose');
		await closeOutTask('s-low', 'done', 'just looked something up', {});
		expect(adv).not.toHaveBeenCalled();
		expect(synth).toHaveBeenCalledWith(expect.objectContaining({ concerns: [] }));
	});
});
