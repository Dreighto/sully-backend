import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
const DB = '/tmp/sully-turn-lifecycle-test.db';
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

describe('prepareTurnLifecycle', () => {
	it('mints a task, persists the turn, classifies, resolves the repo', async () => {
		const { prepareTurnLifecycle } = await import('$lib/server/chat/stream_prepare');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const r = await prepareTurnLifecycle({
			text: 'audit the companion repo',
			threadId: 'tL',
			sender: 'operator',
			source: 'voice'
		});
		expect(r.taskId).toMatch(/^sully-/);
		expect(typeof r.currentTier).toBe('string');
		expect(r.userMessageText).toBe('Audit the companion repo.');
		const j = await import('$lib/server/dispatchJobs');
		expect(j.getJobsForThread('tL').length).toBeGreaterThan(0); // a task row exists
	});

	it('normalizes spoken input before the routing layer sees it', async () => {
		const { prepareTurnLifecycle } = await import('$lib/server/chat/stream_prepare');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const r = await prepareTurnLifecycle({
			text: 'um check logue os on the jet son and then i also need the walkie talkie file',
			threadId: 'tNorm',
			sender: 'operator',
			source: 'voice'
		});
		expect(r.userMessageText).toBe(
			'Check LogueOS on the Jetson and then I also need the walkie-talkie file.'
		);
	});
});
