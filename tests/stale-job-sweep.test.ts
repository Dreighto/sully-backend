// LOS-196 part 2 — clock-driven stale-job reaper. Locks: the sweep runs from a
// server-side interval (no client needs to be open), posts the stalled notice,
// shares one 60s throttle across callers, and does NOT change the
// reapStaleJobs() criterion (proven correct during the design investigation).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-stale-sweep-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DISPATCH_ENABLED: 'true',
	ENABLE_WEB_PUSH: 'false'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

function wipe() {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
}

beforeEach(() => {
	wipe();
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
	wipe();
});

/** Mint an in-flight job and backdate started_at past the 15-min reap timeout. */
async function seedStaleJob(traceId: string, threadId = 'thread-reap') {
	const j = await import('$lib/server/dispatchJobs');
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	bootstrapCompanionDb();
	j.createJob({
		traceId,
		worker: 'claude-code',
		category: 'code',
		brief: 'long-lost task',
		fingerprint: 'f',
		predictedTokens: 0,
		threadId
	});
	j.markDispatched(traceId);
	j.markWorking(traceId, 'thinking');
	const db = new Database(DB);
	db.prepare(
		"UPDATE pending_jobs SET started_at = datetime('now', '-20 minutes') WHERE trace_id = ?"
	).run(traceId);
	db.close();
	return j;
}

describe('sweepStaleJobs', () => {
	it('reaps a stale working job and posts the stalled notice to its thread', async () => {
		const j = await seedStaleJob('sully-stale-1');
		const { sweepStaleJobs } = await import('$lib/server/staleJobSweep');
		sweepStaleJobs();
		expect(j.getJob('sully-stale-1')?.status).toBe('failed');
		expect(j.getJob('sully-stale-1')?.current_activity).toBe(
			'stalled: no worker callback within timeout'
		);
		const { getChatMessages } = await import('$lib/server/chat');
		const msgs = getChatMessages(50, 'thread-reap');
		expect(msgs.some((m) => m.message.includes('That task stalled'))).toBe(true);
	});

	it('shares one 60s throttle across callers — a second immediate sweep is a no-op', async () => {
		vi.useFakeTimers();
		const j = await seedStaleJob('sully-stale-2');
		const { sweepStaleJobs } = await import('$lib/server/staleJobSweep');
		sweepStaleJobs();
		expect(j.getJob('sully-stale-2')?.status).toBe('failed');

		// A second stale job appearing right after: the immediate re-sweep is
		// throttled; after 60s it goes through.
		await seedStaleJob('sully-stale-3');
		sweepStaleJobs();
		expect(j.getJob('sully-stale-3')?.status).toBe('working');
		vi.advanceTimersByTime(61_000);
		sweepStaleJobs();
		expect(j.getJob('sully-stale-3')?.status).toBe('failed');
	});

	it('leaves fresh in-flight jobs alone (no criterion change)', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		j.createJob({
			traceId: 'sully-fresh-1',
			worker: 'claude-code',
			category: 'code',
			brief: 'fresh task',
			fingerprint: 'f',
			predictedTokens: 0,
			threadId: 'thread-reap'
		});
		j.markDispatched('sully-fresh-1');
		const { sweepStaleJobs } = await import('$lib/server/staleJobSweep');
		sweepStaleJobs();
		expect(j.getJob('sully-fresh-1')?.status).toBe('dispatched');
	});
});

describe('startStaleJobReaper — the server-side interval', () => {
	it('reaps on the clock with NO client request involved', async () => {
		vi.useFakeTimers();
		const j = await seedStaleJob('sully-clock-1');
		const { startStaleJobReaper } = await import('$lib/server/staleJobSweep');
		startStaleJobReaper();
		expect(j.getJob('sully-clock-1')?.status).toBe('working'); // not yet — interval hasn't fired
		vi.advanceTimersByTime(60_000);
		expect(j.getJob('sully-clock-1')?.status).toBe('failed');
		const { getChatMessages } = await import('$lib/server/chat');
		expect(
			getChatMessages(50, 'thread-reap').some((m) => m.message.includes('That task stalled'))
		).toBe(true);
	});

	it('is idempotent — a double start arms exactly one interval', async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		const { startStaleJobReaper } = await import('$lib/server/staleJobSweep');
		startStaleJobReaper();
		startStaleJobReaper();
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		setIntervalSpy.mockRestore();
	});
});

describe('hooks + activity-route wiring (source-level)', () => {
	it('hooks.server.ts starts the reaper and the activity GET keeps the piggyback', () => {
		const hooks = fs.readFileSync('src/hooks.server.ts', 'utf-8');
		expect(hooks).toContain('startStaleJobReaper()');
		const route = fs.readFileSync('src/routes/api/chat/activity/+server.ts', 'utf-8');
		expect(route).toContain('sweepStaleJobs()');
	});
});

describe('reapAbandonedProposals (via sweepStaleJobs)', () => {
	async function seedPreflight(traceId: string, status: string, backdate: string) {
		const j = await import('$lib/server/dispatchJobs');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		j.proposeTask({
			taskId: traceId,
			threadId: 'thread-ageout',
			source: 'test',
			category: 'general',
			brief: 'abandoned pre-flight row'
		});
		const db = new Database(DB);
		db.prepare(
			"UPDATE pending_jobs SET status = ?, started_at = datetime('now', ?) WHERE trace_id = ?"
		).run(status, backdate, traceId);
		db.close();
		return j;
	}

	it('ages out proposed/gated/held >7d and classified >48h to aborted', async () => {
		const j = await seedPreflight('sully-age-1', 'proposed', '-8 days');
		await seedPreflight('sully-age-2', 'gated', '-8 days');
		await seedPreflight('sully-age-3', 'classified', '-3 days');
		await seedPreflight('sully-age-8', 'held', '-8 days');
		const { sweepStaleJobs } = await import('$lib/server/staleJobSweep');
		sweepStaleJobs();
		for (const t of ['sully-age-1', 'sully-age-2', 'sully-age-3', 'sully-age-8']) {
			expect(j.getJob(t)?.status).toBe('aborted');
			expect(j.getJob(t)?.current_activity).toBe('aged out: never confirmed or dispatched');
			expect(j.getJob(t)?.ended_at).toBeTruthy();
		}
	});

	it('leaves recent pre-flight rows alone — a live proposal must survive', async () => {
		const j = await seedPreflight('sully-age-4', 'proposed', '-1 days');
		await seedPreflight('sully-age-5', 'gated', '-6 days');
		await seedPreflight('sully-age-6', 'classified', '-1 days');
		const { sweepStaleJobs } = await import('$lib/server/staleJobSweep');
		sweepStaleJobs();
		expect(j.getJob('sully-age-4')?.status).toBe('proposed');
		expect(j.getJob('sully-age-5')?.status).toBe('gated');
		expect(j.getJob('sully-age-6')?.status).toBe('classified');
	});

	it('does not post chat messages for aged pre-flight rows (silent by design)', async () => {
		await seedPreflight('sully-age-7', 'proposed', '-30 days');
		const { sweepStaleJobs } = await import('$lib/server/staleJobSweep');
		sweepStaleJobs();
		const { getChatMessages } = await import('$lib/server/chat');
		const msgs = getChatMessages(50, 'thread-ageout');
		expect(msgs.some((m) => m.message.includes('stalled'))).toBe(false);
	});

	it('a row that advances past pre-flight between sweeps is never clobbered (atomic predicate)', async () => {
		// Simulates the confirm race: the row is old enough to age out, but its
		// status moved to 'dispatched' before the sweep's UPDATE ran. The age
		// predicate re-checks status at write time, so it must survive.
		const j = await seedPreflight('sully-age-9', 'dispatched', '-30 days');
		const { sweepStaleJobs } = await import('$lib/server/staleJobSweep');
		sweepStaleJobs();
		const status = j.getJob('sully-age-9')?.status;
		// reapStaleJobs (the in-flight reaper) may mark it failed-stalled, but
		// the proposal age-out must NOT have stamped it 'aged out'.
		expect(j.getJob('sully-age-9')?.current_activity).not.toBe(
			'aged out: never confirmed or dispatched'
		);
		expect(status).not.toBe('aborted');
	});
});
