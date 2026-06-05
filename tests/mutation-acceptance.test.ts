// Acceptance #7 + #8 — mutation gate: conversation flows; running-task
// work-intent never injects into / drops the running task.
//
// Drives maybeAutonomousDispatch with a seeded RUNNING task on the thread,
// with dispatchToWorker mocked so we can assert whether it was called and
// with what arguments.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-mutation-acceptance-test.db';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: DB,
		COMPANION_DISPATCH_ENABLED: 'true'
	}
}));

// Mock dispatchToWorker so we never hit the real listener. Track calls.
const dispatchMock = vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string });
vi.mock('$lib/server/companionDispatch', () => ({ dispatchToWorker: dispatchMock }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
	dispatchMock.mockClear();
	dispatchMock.mockResolvedValue({ ok: true });
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

/** Seed a RUNNING task (decided→dispatched) on a thread. Returns the trace_id. */
async function seedRunning(threadId: string, traceId: string) {
	const j = await import('$lib/server/dispatchJobs');
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	bootstrapCompanionDb();
	j.createJob({
		traceId,
		worker: 'claude-code',
		category: 'code',
		brief: 'fix the console build',
		fingerprint: 'f',
		predictedTokens: 0,
		threadId
	});
	j.markDispatched(traceId);
	return traceId;
}

describe('acceptance #7 — conversation is NOT blocked by a running task', () => {
	it('RUNNING task + plain chat → CONVERSATIONAL_ONLY, dispatchToWorker never called, running task untouched', async () => {
		const runningId = await seedRunning('t7', 'run-7');

		const j = await import('$lib/server/dispatchJobs');
		const { runMutationGate } = await import('$lib/server/routing/mutation_gate');
		const { maybeAutonomousDispatch } = await import('$lib/server/chat/autonomous_dispatch');

		const gate = runMutationGate('t7', 'thanks, looks good');
		expect(gate.classification).toBe('CONVERSATIONAL_ONLY');

		// Seed the current turn's task so maybeAutonomousDispatch has a proposed row.
		j.proposeTask({
			taskId: 'sully-t7-reply',
			threadId: 't7',
			source: 'chat',
			category: 'general',
			brief: 'thanks, looks good'
		});

		const result = await maybeAutonomousDispatch({
			userText: 'thanks, looks good',
			targetRepo: 'companion',
			threadId: 't7',
			taskId: 'sully-t7-reply',
			tier: 'chat',
			mutationGate: gate
		});

		// No dispatch.
		expect(dispatchMock).not.toHaveBeenCalled();
		// Running task row is untouched (still dispatched).
		expect(j.getJob(runningId)?.status).toBe('dispatched');
		// No spoken suffix — pure conversation.
		expect(result.spokenSuffix).toBeUndefined();
	});
});

describe('acceptance #8 — work-intent during running task never injects or drops', () => {
	it('#8a — RUNNING task + work-intent → routing-ask posted, dispatchToWorker never called, running task untouched', async () => {
		const runningId = await seedRunning('t8a', 'run-8a');

		const j = await import('$lib/server/dispatchJobs');
		const { runMutationGate } = await import('$lib/server/routing/mutation_gate');
		const { maybeAutonomousDispatch } = await import('$lib/server/chat/autonomous_dispatch');

		const gate = runMutationGate('t8a', 'also fix the console build');
		expect(gate.classification).toBe('RUNNING_WORK_INTENT');

		j.proposeTask({
			taskId: 'sully-t8a-work',
			threadId: 't8a',
			source: 'chat',
			category: 'code',
			brief: 'also fix the console build'
		});
		j.markClassified('sully-t8a-work', 'code', null);

		const result = await maybeAutonomousDispatch({
			userText: 'also fix the console build',
			targetRepo: 'companion',
			threadId: 't8a',
			taskId: 'sully-t8a-work',
			tier: 'deep',
			mutationGate: gate
		});

		// No dispatch — the running task must NEVER be touched.
		expect(dispatchMock).not.toHaveBeenCalled();
		// Running task still dispatched (untouched).
		expect(j.getJob(runningId)?.status).toBe('dispatched');
		// The current turn was stored as a routing_ask gated proposal.
		const proposal = j.getPendingProposal('t8a');
		expect(proposal?.taskId).toBe('sully-t8a-work');
		expect(proposal?.proposalType).toBe('routing_ask');
		// A routing-ask message was posted.
		expect(result.spokenSuffix).toMatch(/task running/i);
	});

	it('#8b — answer "separately" → sibling dispatched as NEW trace (NOT the running task)', async () => {
		const runningId = await seedRunning('t8b', 'run-8b');

		const j = await import('$lib/server/dispatchJobs');
		const { runMutationGate } = await import('$lib/server/routing/mutation_gate');
		const { maybeAutonomousDispatch } = await import('$lib/server/chat/autonomous_dispatch');

		// Turn 1: work-intent during running task → routing-ask
		const gate8b = runMutationGate('t8b', 'also fix the console build');
		j.proposeTask({
			taskId: 'sully-t8b-work',
			threadId: 't8b',
			source: 'chat',
			category: 'code',
			brief: 'also fix the console build'
		});
		j.markClassified('sully-t8b-work', 'code', null);
		await maybeAutonomousDispatch({
			userText: 'also fix the console build',
			targetRepo: 'companion',
			threadId: 't8b',
			taskId: 'sully-t8b-work',
			tier: 'deep',
			mutationGate: gate8b
		});
		expect(dispatchMock).not.toHaveBeenCalled();
		expect(j.getPendingProposal('t8b')?.proposalType).toBe('routing_ask');

		// Turn 2: operator answers "run it separately" — a sibling should be dispatched
		// The gate for THIS turn: running task is still running → gate fires.
		// But we have a routing_ask pending — that takes priority in the function.
		const gateSep = runMutationGate('t8b', 'run it separately');
		j.proposeTask({
			taskId: 'sully-t8b-sep',
			threadId: 't8b',
			source: 'chat',
			category: 'general',
			brief: 'run it separately'
		});
		const result = await maybeAutonomousDispatch({
			userText: 'run it separately',
			targetRepo: 'companion',
			threadId: 't8b',
			taskId: 'sully-t8b-sep',
			tier: 'chat',
			mutationGate: gateSep
		});

		// dispatchToWorker called ONCE — for the sibling (new trace), not the running one.
		expect(dispatchMock).toHaveBeenCalledTimes(1);
		// The dispatched traceId is NOT the running task's id and NOT the asking turn's id.
		// Verify by checking it was NOT called with those ids.
		expect(dispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ traceId: runningId }));
		expect(dispatchMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ traceId: 'sully-t8b-work' })
		);
		// Running task row is still untouched.
		expect(j.getJob(runningId)?.status).toBe('dispatched');
		// Routing-ask proposal was consumed (aborted).
		expect(j.getPendingProposal('t8b')).toBeNull();
		expect(result.spokenSuffix).toMatch(/separate/i);
	});

	it('#8c — answer "hold it" → no dispatch, held content recorded, routing-ask consumed', async () => {
		const runningId = await seedRunning('t8c', 'run-8c');

		const j = await import('$lib/server/dispatchJobs');
		const { runMutationGate } = await import('$lib/server/routing/mutation_gate');
		const { maybeAutonomousDispatch } = await import('$lib/server/chat/autonomous_dispatch');

		// Turn 1: work-intent → routing-ask
		const gate8c = runMutationGate('t8c', 'also audit the console repo');
		j.proposeTask({
			taskId: 'sully-t8c-work',
			threadId: 't8c',
			source: 'chat',
			category: 'code',
			brief: 'also audit the console repo'
		});
		j.markClassified('sully-t8c-work', 'code', null);
		await maybeAutonomousDispatch({
			userText: 'also audit the console repo',
			targetRepo: 'companion',
			threadId: 't8c',
			taskId: 'sully-t8c-work',
			tier: 'deep',
			mutationGate: gate8c
		});
		expect(dispatchMock).not.toHaveBeenCalled();

		// Turn 2: operator answers "hold it"
		const gateHold = runMutationGate('t8c', 'hold it');
		j.proposeTask({
			taskId: 'sully-t8c-hold',
			threadId: 't8c',
			source: 'chat',
			category: 'general',
			brief: 'hold it'
		});
		const result = await maybeAutonomousDispatch({
			userText: 'hold it',
			targetRepo: 'companion',
			threadId: 't8c',
			taskId: 'sully-t8c-hold',
			tier: 'chat',
			mutationGate: gateHold
		});

		// No dispatch at all.
		expect(dispatchMock).not.toHaveBeenCalled();
		// Running task is untouched.
		expect(j.getJob(runningId)?.status).toBe('dispatched');
		// Routing-ask proposal consumed (aborted, not leaked).
		expect(j.getPendingProposal('t8c')).toBeNull();
		// The routing-ask row itself is now aborted (held content recorded in its brief).
		const askRow = j.getJob('sully-t8c-work');
		expect(askRow?.status).toBe('aborted');
		// Operator got a "I'll hold that" message.
		expect(result.spokenSuffix).toMatch(/hold/i);
	});
});
