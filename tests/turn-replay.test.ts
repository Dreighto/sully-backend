// Locks the Phase 1 Task journal + reader API end-to-end:
//   - every turn (text or voice) mints a 'proposed' Task carrying task_id,
//   - the operator + assistant rows carry task_id + forensics,
//   - journal events land in chat_activity,
//   - replayTurn / replayTurnByMessage / replayThreadRecent stitch them back.
//
// Exercises the two canonical shapes the reader API must handle: a non-
// dispatched (pure chat) turn that classifies to 'classified' (Phase 0), and a
// dispatched turn promoted through the worker FSM to 'done'.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const DB = '/tmp/sully-turn-replay-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

function wipeDb() {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
}

beforeEach(() => {
	wipeDb();
	vi.resetModules();
});
afterEach(() => {
	wipeDb();
});

async function runTurn(opts: {
	taskId: string;
	threadId: string;
	userText: string;
	replyText: string;
	source?: string;
}) {
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	bootstrapCompanionDb();
	const { persistUserTurn, classifyAndTouchThread, persistAssistantTurn } =
		await import('$lib/server/chat_turn');
	const op = persistUserTurn({
		text: opts.userText,
		threadId: opts.threadId,
		taskId: opts.taskId,
		source: opts.source ?? 'chat'
	});
	const { currentTier } = classifyAndTouchThread({
		threadId: opts.threadId,
		userText: opts.userText,
		taskId: opts.taskId
	});
	persistAssistantTurn({
		text: opts.replyText,
		sender: 'local',
		threadId: opts.threadId,
		model: 'gemini-2.5-flash-lite',
		tier: currentTier,
		taskId: opts.taskId,
		provider: 'google',
		promptTokens: 11,
		completionTokens: 7,
		latencyMs: 123
	});
	return { operatorMessageId: op.row.id };
}

describe('turn_replay — non-dispatched (pure chat) turn', () => {
	it('mints a proposed Task, links both rows + forensics, journals events', async () => {
		await runTurn({
			taskId: 'sully-chat-1',
			threadId: 't1',
			userText: 'hey sully, what time is it?',
			replyText: "It's just past three."
		});
		const { replayTurn } = await import('$lib/server/turn_replay');
		const r = replayTurn('sully-chat-1');

		expect(r).not.toBeNull();
		// Phase 0: the classifier now writes its tier onto the Task row, advancing
		// proposed→classified (still pre-dispatch, so `dispatched` stays false).
		expect(r!.task?.status).toBe('classified');
		expect(r!.task?.classification_tier).toBe('chat');
		expect(r!.dispatched).toBe(false);
		expect(r!.thread_id).toBe('t1');
		expect(r!.task?.source).toBe('chat');

		// Both rows carry the task_id, oldest first.
		expect(r!.messages.map((m) => m.sender)).toEqual(['operator', 'local']);
		const reply = r!.messages[1];
		expect(reply.model).toBe('gemini-2.5-flash-lite');
		expect(reply.provider).toBe('google');
		expect(reply.prompt_tokens).toBe(11);
		expect(reply.completion_tokens).toBe(7);
		expect(reply.latency_ms).toBe(123);

		// Journal recorded the turn lifecycle.
		const actions = r!.events.map((e) => e.action);
		expect(actions).toContain('task_proposed');
		expect(actions).toContain('classifier_ran');
		expect(actions).toContain('reply_persisted');
	});
});

describe('turn_replay — dispatched turn promoted through the FSM', () => {
	it('promotes proposed→decided→…→done and replays the worker arc', async () => {
		await runTurn({
			taskId: 'sully-disp-1',
			threadId: 't2',
			userText: 'fix the failing build in chat_prompt.ts',
			replyText: "I'm on it."
		});
		// Simulate the dispatch promoting the proposed row, then the worker FSM.
		const j = await import('$lib/server/dispatchJobs');
		j.createJob({
			traceId: 'sully-disp-1',
			worker: 'claude-code',
			category: 'code',
			brief: 'fix the failing build',
			fingerprint: 'fp-1',
			predictedTokens: 0,
			threadId: 't2',
			source: 'dispatch'
		});
		j.markDispatched('sully-disp-1');
		j.markWorking('sully-disp-1', 'reading chat_prompt.ts');
		j.markDone('sully-disp-1', 'artifact://pr-42');

		const { replayTurn } = await import('$lib/server/turn_replay');
		const r = replayTurn('sully-disp-1');

		expect(r).not.toBeNull();
		expect(r!.task?.status).toBe('done');
		expect(r!.dispatched).toBe(true);
		expect(r!.task?.worker).toBe('claude-code');
		expect(r!.task?.result_ref).toBe('artifact://pr-42');
		// thread_id survived the proposed→decided promotion (COALESCE).
		expect(r!.task?.thread_id).toBe('t2');
	});
});

describe('turn_replay — lookup helpers', () => {
	it('replayTurnByMessage finds the Task from a message id', async () => {
		const { operatorMessageId } = await runTurn({
			taskId: 'sully-chat-2',
			threadId: 't3',
			userText: 'remember I like terse answers',
			replyText: 'Noted.'
		});
		const { replayTurnByMessage } = await import('$lib/server/turn_replay');
		const r = replayTurnByMessage(operatorMessageId);
		expect(r?.task_id).toBe('sully-chat-2');
	});

	it('replayThreadRecent returns recent Tasks newest-first', async () => {
		await runTurn({ taskId: 'sully-a', threadId: 't4', userText: 'first', replyText: 'ok' });
		await runTurn({ taskId: 'sully-b', threadId: 't4', userText: 'second', replyText: 'ok' });
		const { replayThreadRecent } = await import('$lib/server/turn_replay');
		const rows = replayThreadRecent('t4', 5);
		expect(rows.map((r) => r.task_id)).toContain('sully-a');
		expect(rows.map((r) => r.task_id)).toContain('sully-b');
	});

	it('returns null for an unknown task id (e.g. pre-migration turn)', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const { replayTurn } = await import('$lib/server/turn_replay');
		expect(replayTurn('sully-does-not-exist')).toBeNull();
	});
});
