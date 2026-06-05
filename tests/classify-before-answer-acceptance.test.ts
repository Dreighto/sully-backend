// D2.4: Acceptance tests #1-#4 — classify-before-answer reorder (Plan D R2).
//
// Tests exercise the decision layer (resolveTurnDecision + needsFullReply +
// applyTurnDecision + prepareTurnLifecycle). Route handlers are not unit-tested
// here; the live audit re-run is the integration proof. DB-backed (real SQLite).
//
// #1 Brainstorming does not auto-dispatch.
// #2 Explicit work intent creates a task.
// #3 Voice + text resolve the SAME decision from the shared chokepoint.
// #4 A work turn does not generate a full reply (needsFullReply gate).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-classify-before-answer-test.db';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: DB,
		COMPANION_DISPATCH_ENABLED: 'true'
	}
}));

// Mock dispatchToWorker so no real listener is hit.
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

async function setup() {
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	bootstrapCompanionDb();
	const { resolveTurnDecision, needsFullReply } = await import('$lib/server/routing/turn_decision');
	const jobs = await import('$lib/server/dispatchJobs');
	const { applyTurnDecision } = await import('$lib/server/chat/autonomous_dispatch');
	const { prepareTurnLifecycle } = await import('$lib/server/chat/stream_prepare');
	return { resolveTurnDecision, needsFullReply, jobs, applyTurnDecision, prepareTurnLifecycle };
}

// ─── Acceptance #1: brainstorming does not auto-dispatch ─────────────────────
describe('acceptance #1 — brainstorm does not auto-dispatch', () => {
	it('brainstorm userText → ANSWER_NOW; needsFullReply true; no task promoted, dispatchMock never called', async () => {
		const { resolveTurnDecision, needsFullReply, jobs, applyTurnDecision } = await setup();

		const userText = 'just kicking an idea around, no action needed';
		const threadId = 'tAcc1';

		// Seed a proposed task (the turn's Task id) so applyTurnDecision can write.
		const taskId = 'sully-acc1';
		jobs.proposeTask({ taskId, threadId, source: 'chat', category: 'general', brief: userText });

		const decision = resolveTurnDecision({ userText, threadId, tier: 'chat' });
		expect(decision.kind).toBe('ANSWER_NOW');
		expect(needsFullReply(decision)).toBe(true);

		// applyTurnDecision on ANSWER_NOW journals Talk + markSelfHandled — no dispatch.
		await applyTurnDecision(decision, { taskId, threadId, targetRepo: 'companion', userText });

		// No dispatch call was made.
		expect(dispatchMock).not.toHaveBeenCalled();

		// Task was self-handled (not dispatched, not gated).
		const job = jobs.getJob(taskId);
		expect(job?.status).not.toBe('dispatched');
		expect(job?.status).not.toBe('gated');
	});
});

// ─── Acceptance #2: explicit work intent creates a task ──────────────────────
describe('acceptance #2 — explicit work intent creates a proposal or dispatch', () => {
	it('work-intent userText → PROPOSE; needsFullReply false; applyTurnDecision gates the task', async () => {
		const { resolveTurnDecision, needsFullReply, jobs, applyTurnDecision } = await setup();

		const userText = 'audit the console repo and fix the build';
		const threadId = 'tAcc2a';
		const taskId = 'sully-acc2a';
		jobs.proposeTask({ taskId, threadId, source: 'chat', category: 'code', brief: userText });

		const decision = resolveTurnDecision({ userText, threadId });
		expect(decision.kind).toBe('PROPOSE');
		expect(needsFullReply(decision)).toBe(false);

		// applyTurnDecision on PROPOSE gates the task + marks a pending proposal.
		await applyTurnDecision(decision, { taskId, threadId, targetRepo: 'companion', userText });

		// Task is gated (pending approval) — not yet dispatched.
		const job = jobs.getJob(taskId);
		expect(job?.status).toBe('gated');
		// A pending proposal for the thread was recorded.
		const pending = jobs.getPendingProposal(threadId);
		expect(pending?.taskId).toBe(taskId);
		expect(dispatchMock).not.toHaveBeenCalled();
	});

	it('@cc userText → DISPATCH; needsFullReply false; applyTurnDecision dispatches', async () => {
		const { resolveTurnDecision, needsFullReply, jobs, applyTurnDecision } = await setup();

		const userText = '@cc fix the failing auth endpoint';
		const threadId = 'tAcc2b';
		const taskId = 'sully-acc2b';
		jobs.proposeTask({ taskId, threadId, source: 'chat', category: 'code', brief: userText });

		const decision = resolveTurnDecision({ userText, threadId });
		expect(decision.kind).toBe('DISPATCH');
		expect(needsFullReply(decision)).toBe(false);

		await applyTurnDecision(decision, { taskId, threadId, targetRepo: 'companion', userText });

		// dispatchMock was called once.
		expect(dispatchMock).toHaveBeenCalledTimes(1);
	});
});

// ─── Acceptance #3: voice + text resolve the SAME decision ───────────────────
describe('acceptance #3 — voice and text resolve the same decision from the shared chokepoint', () => {
	it('prepareTurnLifecycle({source:"chat"}) and ({source:"voice"}) yield the same shadowDecision.kind', async () => {
		const { prepareTurnLifecycle } = await setup();

		const userText = 'audit the console repo and fix the build';

		const chatResult = await prepareTurnLifecycle({
			text: userText,
			threadId: 'tAcc3a',
			source: 'chat',
			sender: 'operator'
		});
		const voiceResult = await prepareTurnLifecycle({
			text: userText,
			threadId: 'tAcc3b',
			source: 'voice',
			sender: 'operator'
		});

		// Both go through resolveTurnDecision with the same text — same kind.
		expect(chatResult.shadowDecision.kind).toBe(voiceResult.shadowDecision.kind);
		// For a work-intent both should resolve to PROPOSE.
		expect(chatResult.shadowDecision.kind).toBe('PROPOSE');
	});

	it('brainstorm text: chat and voice both resolve ANSWER_NOW', async () => {
		const { prepareTurnLifecycle } = await setup();

		const userText = 'just kicking an idea around, no action needed';

		const chatResult = await prepareTurnLifecycle({
			text: userText,
			threadId: 'tAcc3c',
			source: 'chat',
			sender: 'operator'
		});
		const voiceResult = await prepareTurnLifecycle({
			text: userText,
			threadId: 'tAcc3d',
			source: 'voice',
			sender: 'operator'
		});

		expect(chatResult.shadowDecision.kind).toBe('ANSWER_NOW');
		expect(voiceResult.shadowDecision.kind).toBe('ANSWER_NOW');
	});
});

// ─── Acceptance #4: a work turn does NOT generate a full reply ───────────────
describe('acceptance #4 — needsFullReply gates model generation', () => {
	it('work userText → needsFullReply false (handler skips model call)', async () => {
		const { resolveTurnDecision, needsFullReply } = await setup();
		const d = resolveTurnDecision({
			userText: 'audit the console repo and fix the build',
			threadId: 'tAcc4a'
		});
		expect(needsFullReply(d)).toBe(false);
	});

	it('brainstorm userText → needsFullReply true (handler streams full reply)', async () => {
		const { resolveTurnDecision, needsFullReply } = await setup();
		const d = resolveTurnDecision({
			userText: 'just kicking an idea around, no action needed',
			threadId: 'tAcc4b',
			tier: 'chat'
		});
		expect(needsFullReply(d)).toBe(true);
	});

	it('@cc explicit dispatch → needsFullReply false', async () => {
		const { resolveTurnDecision, needsFullReply } = await setup();
		const d = resolveTurnDecision({
			userText: '@cc fix the failing auth endpoint',
			threadId: 'tAcc4c'
		});
		expect(needsFullReply(d)).toBe(false);
	});

	it('CONVERSATIONAL_ONLY (running task + chat) → needsFullReply true (MUST NOT block)', async () => {
		const { resolveTurnDecision, needsFullReply } = await setup();
		const d = resolveTurnDecision({
			userText: 'thanks, that all makes sense',
			threadId: 'tAcc4d',
			mutationGate: {
				classification: 'CONVERSATIONAL_ONLY',
				activeTaskId: 'run-acc4d',
				activeTaskStatus: 'dispatched'
			}
		});
		expect(d.kind).toBe('CONVERSATIONAL_ONLY');
		expect(needsFullReply(d)).toBe(true);
	});
});
