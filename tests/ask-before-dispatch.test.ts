import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-ask-before-dispatch-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	COMPANION_DISPATCH_ENABLED: 'true',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	COMPANION_DISPATCH_CAP: '20',
	COMPANION_DISPATCH_WINDOW_MIN: '1440',
	COMPANION_CALLBACK_SECRET: 'cbsecret',
	COMPANION_CALLBACK_BASE_URL: 'https://room.example.ts.net:8444/companion',
	LOGUEOS_DISPATCH_LISTENER_URL: 'http://127.0.0.1:19100',
	W4_LISTENER_HMAC_SECRET: 'listenersecret',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

let fetchCalls = 0;
beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
	fetchCalls = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			fetchCalls += 1;
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		})
	);
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	vi.unstubAllGlobals();
});

async function setup() {
	const disp = await import('$lib/server/chat/autonomous_dispatch');
	const jobs = await import('$lib/server/dispatchJobs');
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	bootstrapCompanionDb();
	return { ...disp, ...jobs };
}

describe('ask-before-dispatch', () => {
	it('PROPOSES (Ask) without dispatching — stores a gated proposal + returns a spoken ask', async () => {
		const m = await setup();
		m.proposeTask({
			taskId: 'sully-ask1',
			threadId: 'tA',
			source: 'chat',
			category: 'general',
			brief: 'x'
		});
		const r = await m.maybeAutonomousDispatch({
			userText: 'add a settings page to the console',
			targetRepo: 'companion',
			threadId: 'tA',
			taskId: 'sully-ask1',
			tier: 'planning'
		});
		expect(m.getJob('sully-ask1')?.status).toBe('gated');
		expect(m.getPendingProposal('tA')?.taskId).toBe('sully-ask1');
		expect(r.spokenSuffix).toMatch(/Want me to run it/);
		expect(fetchCalls).toBe(0); // nothing dispatched yet
	});

	it('CONFIRMS on the next turn — "yes" dispatches the gated proposal', async () => {
		const m = await setup();
		m.proposeTask({
			taskId: 'sully-ask2',
			threadId: 'tB',
			source: 'chat',
			category: 'general',
			brief: 'x'
		});
		await m.maybeAutonomousDispatch({
			userText: 'add a settings page to the console',
			targetRepo: 'companion',
			threadId: 'tB',
			taskId: 'sully-ask2',
			tier: 'planning'
		});
		expect(fetchCalls).toBe(0);
		// Next turn: the operator confirms.
		m.proposeTask({
			taskId: 'sully-yes',
			threadId: 'tB',
			source: 'chat',
			category: 'general',
			brief: 'yes'
		});
		const r = await m.maybeAutonomousDispatch({
			userText: 'yes',
			targetRepo: 'companion',
			threadId: 'tB',
			taskId: 'sully-yes',
			tier: 'chat'
		});
		expect(m.getJob('sully-ask2')?.status).toBe('dispatched'); // proposal fired
		expect(fetchCalls).toBe(1);
		expect(r.spokenSuffix).toMatch(/On it/);
	});

	it('EXPIRES on a non-affirmation next turn — proposal aborted, nothing dispatched', async () => {
		const m = await setup();
		m.proposeTask({
			taskId: 'sully-ask3',
			threadId: 'tC',
			source: 'chat',
			category: 'general',
			brief: 'x'
		});
		await m.maybeAutonomousDispatch({
			userText: 'refactor src/lib/server/chat.ts',
			targetRepo: 'companion',
			threadId: 'tC',
			taskId: 'sully-ask3',
			tier: 'deep'
		});
		expect(m.getJob('sully-ask3')?.status).toBe('gated');
		// Next turn: operator changes the subject (not an affirmation).
		m.proposeTask({
			taskId: 'sully-other',
			threadId: 'tC',
			source: 'chat',
			category: 'general',
			brief: 'o'
		});
		await m.maybeAutonomousDispatch({
			userText: 'actually, what time is it there?',
			targetRepo: 'companion',
			threadId: 'tC',
			taskId: 'sully-other',
			tier: 'chat'
		});
		expect(m.getJob('sully-ask3')?.status).toBe('aborted'); // expired, not stranded
		expect(fetchCalls).toBe(0); // never dispatched
	});

	it('a non-affirmation turn expires the proposal at turn-start, so a LATER yes cannot fire it', async () => {
		const m = await setup();
		const { classifyAndTouchThread } = await import('$lib/server/chat_turn');
		m.proposeTask({
			taskId: 'sully-skip1',
			threadId: 'tSkip',
			source: 'chat',
			category: 'general',
			brief: 'x'
		});
		await m.maybeAutonomousDispatch({
			userText: 'add a settings page to the console',
			targetRepo: 'companion',
			threadId: 'tSkip',
			taskId: 'sully-skip1',
			tier: 'planning'
		});
		expect(m.getJob('sully-skip1')?.status).toBe('gated');
		// A non-affirmation turn arrives — turn-start classify runs unconditionally
		// (even if that turn's reply later errors/empties) and expires the proposal.
		classifyAndTouchThread({
			threadId: 'tSkip',
			userText: 'actually, what time is it?',
			taskId: 'sully-skip2'
		});
		expect(m.getJob('sully-skip1')?.status).toBe('aborted');
		// A subsequent "yes" must NOT resurrect the expired proposal.
		m.proposeTask({
			taskId: 'sully-skip3',
			threadId: 'tSkip',
			source: 'chat',
			category: 'general',
			brief: 'yes'
		});
		await m.maybeAutonomousDispatch({
			userText: 'yes',
			targetRepo: 'companion',
			threadId: 'tSkip',
			taskId: 'sully-skip3',
			tier: 'chat'
		});
		expect(fetchCalls).toBe(0);
	});

	it('explicit @cc still dispatches immediately (no ask)', async () => {
		const m = await setup();
		m.proposeTask({
			taskId: 'sully-cc',
			threadId: 'tD',
			source: 'chat',
			category: 'general',
			brief: 'x'
		});
		await m.maybeAutonomousDispatch({
			userText: '@cc fix the failing build in the auth endpoint',
			targetRepo: 'companion',
			threadId: 'tD',
			taskId: 'sully-cc',
			tier: 'chat'
		});
		expect(fetchCalls).toBe(1); // fired without a proposal
		expect(m.getPendingProposal('tD')).toBeNull();
	});
	it('IMPORTANT 2 - a routing-answer turn preserves a routing_ask proposal (classifyAndTouchThread guard)', async () => {
		const m = await setup();
		const { classifyAndTouchThread } = await import('$lib/server/chat_turn');
		// Seed a routing_ask gated proposal on thread tRA
		m.proposeTask({
			taskId: 'sully-ra1',
			threadId: 'tRA',
			source: 'chat',
			category: 'code',
			brief: 'fix the console build'
		});
		m.markClassified('sully-ra1', 'code', null);
		m.markGatedProposal(
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
		expect(m.getJob('sully-ra1')?.status).toBe('gated');
		// A routing-answer turn MUST NOT expire the routing_ask proposal.
		// Before the fix this called expireProposalsForThread and aborted it.
		classifyAndTouchThread({
			threadId: 'tRA',
			userText: 'hold it',
			taskId: 'sully-ra1-reply'
		});
		expect(m.getJob('sully-ra1')?.status).toBe('gated'); // still gated, NOT aborted
		expect(m.getPendingProposal('tRA')?.taskId).toBe('sully-ra1');
	});

	it('IMPORTANT 2 - a non-answer, non-affirmation turn still expires a routing_ask proposal', async () => {
		const m = await setup();
		const { classifyAndTouchThread } = await import('$lib/server/chat_turn');
		m.proposeTask({
			taskId: 'sully-ra2',
			threadId: 'tRB',
			source: 'chat',
			category: 'code',
			brief: 'x'
		});
		m.markClassified('sully-ra2', 'code', null);
		m.markGatedProposal(
			'sully-ra2',
			{
				worker: 'claude-code',
				category: 'code',
				brief: 'x',
				targetRepo: 'companion',
				task: 'x'
			},
			'routing_ask'
		);
		// An unrelated turn (operator moved on) must still expire the proposal.
		classifyAndTouchThread({
			threadId: 'tRB',
			userText: 'what is the weather like today',
			taskId: 'sully-ra2-reply'
		});
		expect(m.getJob('sully-ra2')?.status).toBe('aborted');
	});
});
