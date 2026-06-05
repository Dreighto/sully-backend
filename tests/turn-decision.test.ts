// D1.0: Tests for the pure resolveTurnDecision() function.
// These are DB-backed (real SQLite) for the proposal/gate reads. No mocks for
// side-effecting functions because resolveTurnDecision performs NO writes.
// The critical purity assertion: pending_jobs row count is unchanged after a call.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-turn-decision-test.db';
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

/** Count all rows in pending_jobs. */
function countJobs(): number {
	if (!fs.existsSync(DB)) return 0;
	const db = new Database(DB);
	try {
		const row = db.prepare('SELECT COUNT(*) as n FROM pending_jobs').get() as
			| { n: number }
			| undefined;
		return row?.n ?? 0;
	} catch {
		return 0;
	} finally {
		db.close();
	}
}

async function setup() {
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	bootstrapCompanionDb();
	const jobs = await import('$lib/server/dispatchJobs');
	const { resolveTurnDecision } = await import('$lib/server/routing/turn_decision');
	return { jobs, resolveTurnDecision };
}

describe('resolveTurnDecision — purity: no writes', () => {
	it('does not change pending_jobs row count for a plain chat turn', async () => {
		const { jobs, resolveTurnDecision } = await setup();
		// Seed one row so the table is non-empty.
		jobs.proposeTask({
			taskId: 'sully-purity1',
			threadId: 'tP',
			source: 'chat',
			category: 'general',
			brief: 'seed row'
		});
		const before = countJobs();
		resolveTurnDecision({ userText: 'just kicking an idea around', threadId: 'tP' });
		expect(countJobs()).toBe(before);
	});

	it('does not change pending_jobs row count for a @cc dispatch turn', async () => {
		const { jobs, resolveTurnDecision } = await setup();
		jobs.proposeTask({
			taskId: 'sully-purity2',
			threadId: 'tQ',
			source: 'chat',
			category: 'general',
			brief: 'seed row'
		});
		const before = countJobs();
		resolveTurnDecision({ userText: '@cc fix the build', threadId: 'tQ' });
		expect(countJobs()).toBe(before);
	});

	it('does not change pending_jobs row count when a pending proposal exists', async () => {
		const { jobs, resolveTurnDecision } = await setup();
		jobs.proposeTask({
			taskId: 'sully-purity3',
			threadId: 'tR',
			source: 'chat',
			category: 'general',
			brief: 'audit the console repo'
		});
		jobs.markClassified('sully-purity3', 'code', null);
		jobs.markGatedProposal('sully-purity3', {
			worker: 'claude-code',
			category: 'code',
			brief: 'audit the console repo',
			targetRepo: 'companion',
			task: 'audit the console repo'
		});
		const before = countJobs();
		resolveTurnDecision({ userText: 'yes', threadId: 'tR' });
		expect(countJobs()).toBe(before);
	});
});

describe('resolveTurnDecision — routing_ask branch (A)', () => {
	it('routing_ask pending + "run it separately" → ROUTING_ANSWER sibling', async () => {
		const { jobs, resolveTurnDecision } = await setup();
		jobs.proposeTask({
			taskId: 'sully-ra1',
			threadId: 'tA1',
			source: 'chat',
			category: 'code',
			brief: 'fix the console build'
		});
		jobs.markClassified('sully-ra1', 'code', null);
		jobs.markGatedProposal(
			'sully-ra1',
			{
				worker: 'claude-code',
				category: 'code',
				brief: 'fix the console build',
				targetRepo: 'companion',
				task: 'fix the console build'
			},
			'routing_ask'
		);

		const d = resolveTurnDecision({ userText: 'run it separately', threadId: 'tA1' });
		expect(d.kind).toBe('ROUTING_ANSWER');
		if (d.kind === 'ROUTING_ANSWER') {
			expect(d.answer).toBe('sibling');
			expect(d.proposal.taskId).toBe('sully-ra1');
		}
	});

	it('routing_ask pending + "hold it" → ROUTING_ANSWER defer', async () => {
		const { jobs, resolveTurnDecision } = await setup();
		jobs.proposeTask({
			taskId: 'sully-ra2',
			threadId: 'tA2',
			source: 'chat',
			category: 'code',
			brief: 'fix the console build'
		});
		jobs.markClassified('sully-ra2', 'code', null);
		jobs.markGatedProposal(
			'sully-ra2',
			{
				worker: 'claude-code',
				category: 'code',
				brief: 'fix the console build',
				targetRepo: 'companion',
				task: 'fix the console build'
			},
			'routing_ask'
		);

		const d = resolveTurnDecision({ userText: 'hold it', threadId: 'tA2' });
		expect(d.kind).toBe('ROUTING_ANSWER');
		if (d.kind === 'ROUTING_ANSWER') expect(d.answer).toBe('defer');
	});

	it('routing_ask pending + non-answer → falls through to mutation-gate / decide', async () => {
		const { jobs, resolveTurnDecision } = await setup();
		jobs.proposeTask({
			taskId: 'sully-ra3',
			threadId: 'tA3',
			source: 'chat',
			category: 'code',
			brief: 'fix the console build'
		});
		jobs.markClassified('sully-ra3', 'code', null);
		jobs.markGatedProposal(
			'sully-ra3',
			{
				worker: 'claude-code',
				category: 'code',
				brief: 'fix the console build',
				targetRepo: 'companion',
				task: 'fix the console build'
			},
			'routing_ask'
		);

		const d = resolveTurnDecision({ userText: 'what time is it?', threadId: 'tA3' });
		// Not a routing answer — falls through; plain chat lands at ANSWER_NOW.
		expect(d.kind).toBe('ANSWER_NOW');
	});
});

describe('resolveTurnDecision — mutation gate branch (B)', () => {
	it('mutationGate.classification === RUNNING_WORK_INTENT → RUNNING_WORK_INTENT', async () => {
		const { resolveTurnDecision } = await setup();
		const d = resolveTurnDecision({
			userText: 'fix the console build too',
			threadId: 'tB1',
			mutationGate: {
				classification: 'RUNNING_WORK_INTENT',
				activeTaskId: 'run-B1',
				activeTaskStatus: 'dispatched'
			}
		});
		expect(d.kind).toBe('RUNNING_WORK_INTENT');
		if (d.kind === 'RUNNING_WORK_INTENT') expect(d.activeTaskId).toBe('run-B1');
	});

	it('mutationGate.classification === CONVERSATIONAL_ONLY → CONVERSATIONAL_ONLY', async () => {
		const { resolveTurnDecision } = await setup();
		const d = resolveTurnDecision({
			userText: 'thanks',
			threadId: 'tB2',
			mutationGate: {
				classification: 'CONVERSATIONAL_ONLY',
				activeTaskId: 'run-B2',
				activeTaskStatus: 'dispatched'
			}
		});
		expect(d.kind).toBe('CONVERSATIONAL_ONLY');
	});
});

describe('resolveTurnDecision — affirmation branch (C)', () => {
	it('dispatch proposal pending + "yes" → CONFIRM_PROPOSAL', async () => {
		const { jobs, resolveTurnDecision } = await setup();
		jobs.proposeTask({
			taskId: 'sully-conf1',
			threadId: 'tC1',
			source: 'chat',
			category: 'general',
			brief: 'add settings page'
		});
		jobs.markClassified('sully-conf1', 'code', null);
		jobs.markGatedProposal('sully-conf1', {
			worker: 'claude-code',
			category: 'code',
			brief: 'add settings page',
			targetRepo: 'companion',
			task: 'add settings page'
		});

		const d = resolveTurnDecision({ userText: 'yes', threadId: 'tC1' });
		expect(d.kind).toBe('CONFIRM_PROPOSAL');
		if (d.kind === 'CONFIRM_PROPOSAL') expect(d.proposal.taskId).toBe('sully-conf1');
	});

	it('routing_ask pending + off-script "yes" → CONFIRM_PROPOSAL (held work not silently dropped)', async () => {
		// Behavior parity with pre-D1: the original treated "yes" to ANY pending
		// proposal as a confirm. A routing_ask reaches here only after its task
		// finished; "yes" must run the held work, not leave it to be silently aborted.
		const { jobs, resolveTurnDecision } = await setup();
		jobs.proposeTask({
			taskId: 'sully-ra-yes',
			threadId: 'tCRA',
			source: 'chat',
			category: 'code',
			brief: 'fix the console build'
		});
		jobs.markClassified('sully-ra-yes', 'code', null);
		jobs.markGatedProposal(
			'sully-ra-yes',
			{
				worker: 'claude-code',
				category: 'code',
				brief: 'fix the console build',
				targetRepo: 'companion',
				task: 'fix the console build'
			},
			'routing_ask'
		);
		const d = resolveTurnDecision({ userText: 'yes', threadId: 'tCRA' });
		expect(d.kind).toBe('CONFIRM_PROPOSAL');
		if (d.kind === 'CONFIRM_PROPOSAL') expect(d.proposal.taskId).toBe('sully-ra-yes');
	});
});

describe('resolveTurnDecision — intent gate branch (D)', () => {
	it('@cc fix the build → DISPATCH', async () => {
		const { resolveTurnDecision } = await setup();
		const d = resolveTurnDecision({ userText: '@cc fix the build', threadId: 'tD1' });
		expect(d.kind).toBe('DISPATCH');
		if (d.kind === 'DISPATCH') expect(d.worker).toBe('claude-code');
	});

	it('work intent without @cc → PROPOSE', async () => {
		const { resolveTurnDecision } = await setup();
		const d = resolveTurnDecision({ userText: 'audit the console repo', threadId: 'tD2' });
		expect(d.kind).toBe('PROPOSE');
	});

	it('brainstorm ("just kicking an idea around…") → ANSWER_NOW', async () => {
		const { resolveTurnDecision } = await setup();
		const d = resolveTurnDecision({
			userText: 'just kicking an idea around, no action needed',
			threadId: 'tD3',
			tier: 'chat'
		});
		expect(d.kind).toBe('ANSWER_NOW');
	});
});

// Journal-reason parity: the gate_evaluated payload must carry decide()'s exact
// reason (the pre-D1 flow logged `d.reason`), NOT a hardcoded string. A review
// caught PROPOSE hardcoding 'work-intent' (wrong on the CLI 'work-intent+model-vote'
// path) and ANSWER_NOW hardcoding 'answer-now' (wrong on every Talk turn).
describe('resolveTurnDecision — preserves decide() reason (journal parity)', () => {
	it('PROPOSE (deterministic, no gateBlock) reason matches decide() — "work-intent"', async () => {
		const { resolveTurnDecision } = await setup();
		const { decide } = await import('$lib/server/routing/decide');
		const userText = 'audit the console repo and fix the build';
		const d = resolveTurnDecision({ userText, threadId: 'tRP1' });
		const direct = decide({ userText, fromTool: false });
		expect(d.kind).toBe('PROPOSE');
		if (d.kind === 'PROPOSE') {
			expect(d.reason).toBe(direct.reason);
			expect(d.reason).toBe('work-intent');
		}
	});

	it('PROPOSE (CLI path, escalating gateBlock) reason is "work-intent+model-vote"', async () => {
		const { resolveTurnDecision } = await setup();
		const gateBlock =
			'{"escalate":true,"worker":"claude-code","confidence":0.8,"category":"code","brief":"fix","est_scope":"small"}';
		const d = resolveTurnDecision({
			userText: 'audit the console repo and fix the build',
			threadId: 'tRP2',
			gateBlock
		});
		expect(d.kind).toBe('PROPOSE');
		if (d.kind === 'PROPOSE') expect(d.reason).toBe('work-intent+model-vote');
	});

	it('ANSWER_NOW reason matches decide() (NOT a hardcoded "answer-now")', async () => {
		const { resolveTurnDecision } = await setup();
		const { decide } = await import('$lib/server/routing/decide');
		const userText = 'just kicking an idea around, no action needed';
		const d = resolveTurnDecision({ userText, threadId: 'tRP3', tier: 'chat' });
		const direct = decide({ userText, fromTool: false, recentTier: 'chat' });
		expect(d.kind).toBe('ANSWER_NOW');
		if (d.kind === 'ANSWER_NOW') {
			expect(d.reason).toBe(direct.reason);
			expect(d.reason).not.toBe('answer-now');
		}
	});

	it('DISPATCH reason is decide()\'s "rule:mention"', async () => {
		const { resolveTurnDecision } = await setup();
		const d = resolveTurnDecision({ userText: '@cc fix the build', threadId: 'tRP4' });
		expect(d.kind).toBe('DISPATCH');
		if (d.kind === 'DISPATCH') expect(d.reason).toBe('rule:mention');
	});
});
