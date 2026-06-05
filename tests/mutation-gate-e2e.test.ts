// BLOCKER 1 regression test — the gate must actually fire through
// prepareTurnLifecycle (the real production path). Prior tests called
// runMutationGate directly, bypassing the classify step that inserts the
// current turn's 'classified' row before the gate runs. That insert caused
// getActiveTaskForThread (ORDER BY id DESC) to return the current turn rather
// than the genuinely-running older task, making the gate permanently return
// NO_ACTIVE_TASK in production.
//
// This file tests the gate through the real prepareTurnLifecycle call so
// any future regression of getRunningTaskForThread → getActiveTaskForThread
// will immediately fail here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-mutation-gate-e2e-test.db';
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

/** Seed a RUNNING task on threadId. Returns the trace_id. */
async function seedRunning(threadId: string): Promise<string> {
	const j = await import('$lib/server/dispatchJobs');
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	bootstrapCompanionDb();
	const traceId = `run-${threadId}`;
	j.createJob({
		traceId,
		worker: 'claude-code',
		category: 'code',
		brief: 'fix the console build',
		fingerprint: 'fp',
		predictedTokens: 0,
		threadId
	});
	j.markDispatched(traceId); // status = 'dispatched' — a RUNNING_STATES member
	return traceId;
}

describe('BLOCKER 1 — gate fires through prepareTurnLifecycle (real production path)', () => {
	it(
		'work-intent turn THROUGH prepareTurnLifecycle on thread with RUNNING task → RUNNING_WORK_INTENT, ' +
			'activeTaskId is the running task (NOT the current turn)',
		async () => {
			const runningId = await seedRunning('tE');
			const j = await import('$lib/server/dispatchJobs');

			// Confirm the running task is in place before we call prepareTurnLifecycle.
			const before = j.getRunningTaskForThread('tE');
			expect(before?.trace_id).toBe(runningId);

			const { prepareTurnLifecycle } = await import('$lib/server/chat/stream_prepare');

			const result = await prepareTurnLifecycle({
				text: 'also audit the console repo and fix the build',
				threadId: 'tE',
				sender: 'operator',
				source: 'chat'
			});

			// Core assertion: the gate must have classified this as RUNNING_WORK_INTENT
			// through the real lifecycle path (not just via runMutationGate directly).
			expect(result.mutationGate.classification).toBe('RUNNING_WORK_INTENT');

			// The activeTaskId must be the RUNNING task, not the current turn's task.
			expect(result.mutationGate.activeTaskId).toBe(runningId);
			expect(result.mutationGate.activeTaskId).not.toBe(result.taskId);

			// The running task must still be untouched (dispatched).
			expect(j.getJob(runningId)?.status).toBe('dispatched');
		}
	);

	it('plain-conversation turn THROUGH prepareTurnLifecycle on thread with RUNNING task → CONVERSATIONAL_ONLY', async () => {
		await seedRunning('tF');
		const { prepareTurnLifecycle } = await import('$lib/server/chat/stream_prepare');

		const result = await prepareTurnLifecycle({
			text: 'thanks, that makes sense',
			threadId: 'tF',
			sender: 'operator',
			source: 'chat'
		});

		expect(result.mutationGate.classification).toBe('CONVERSATIONAL_ONLY');
		// activeTaskId is the running task (non-null, informational for logging).
		expect(result.mutationGate.activeTaskId).toBe('run-tF');
	});

	it('turn THROUGH prepareTurnLifecycle on thread with NO running task → NO_ACTIVE_TASK', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const { prepareTurnLifecycle } = await import('$lib/server/chat/stream_prepare');

		const result = await prepareTurnLifecycle({
			text: 'audit the console repo and fix the build',
			threadId: 'tG',
			sender: 'operator',
			source: 'chat'
		});

		expect(result.mutationGate.classification).toBe('NO_ACTIVE_TASK');
		expect(result.mutationGate.activeTaskId).toBeNull();
	});
});
