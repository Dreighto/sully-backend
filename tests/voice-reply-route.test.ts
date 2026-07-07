import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	getChatMessages: vi.fn(),
	resolveVoiceModel: vi.fn(),
	buildVoiceSystemPrompt: vi.fn(),
	persistAssistantTurn: vi.fn(),
	prepareTurnLifecycle: vi.fn(),
	applyTurnDecision: vi.fn(),
	needsFullReply: vi.fn(),
	runVoiceToolLoop: vi.fn(),
	runVoiceStreamingSpeak: vi.fn(),
	heardPrefixFromLog: vi.fn(),
	registerTurn: vi.fn(),
	unregisterTurn: vi.fn(),
	randomUUID: vi.fn()
}));

vi.mock('$lib/server/chat', () => ({
	getChatMessages: state.getChatMessages
}));

vi.mock('$lib/server/model_catalog', () => ({
	resolveVoiceModel: state.resolveVoiceModel
}));

vi.mock('$lib/server/voice_runtime', () => ({
	VOICE_KEEP_ALIVE: '10m'
}));

vi.mock('$lib/server/chat_prompt', () => ({
	buildVoiceSystemPrompt: state.buildVoiceSystemPrompt
}));

vi.mock('$lib/server/chat_turn', () => ({
	persistAssistantTurn: state.persistAssistantTurn
}));

vi.mock('$lib/server/chat/stream_prepare', () => ({
	prepareTurnLifecycle: state.prepareTurnLifecycle
}));

vi.mock('$lib/server/chat/autonomous_dispatch', () => ({
	applyTurnDecision: state.applyTurnDecision
}));

vi.mock('$lib/server/routing/turn_decision', () => ({
	needsFullReply: state.needsFullReply
}));

vi.mock('$lib/server/chat/voice_tools', () => ({
	runVoiceToolLoop: state.runVoiceToolLoop
}));

vi.mock('$lib/server/chat/voice_stream', () => ({
	runVoiceStreamingSpeak: state.runVoiceStreamingSpeak
}));

vi.mock('$lib/server/chat/voice_turn_registry', () => ({
	heardPrefixFromLog: state.heardPrefixFromLog,
	registerTurn: state.registerTurn,
	unregisterTurn: state.unregisterTurn
}));

vi.mock('node:crypto', () => ({
	randomUUID: state.randomUUID
}));

beforeEach(() => {
	vi.clearAllMocks();
	state.getChatMessages.mockReturnValue([]);
	state.resolveVoiceModel.mockReturnValue('companion-v1-voice');
	state.buildVoiceSystemPrompt.mockResolvedValue('You are Sully, a voice assistant.');
	state.persistAssistantTurn.mockReturnValue(42);
	state.prepareTurnLifecycle.mockResolvedValue({
		taskId: 'sully-test-task-001',
		currentTier: 'local',
		targetRepo: undefined,
		shadowDecision: { kind: 'ANSWER_NOW', reason: 'test' },
		userMessageText: 'hello'
	});
	state.applyTurnDecision.mockResolvedValue({});
	state.needsFullReply.mockReturnValue(true);
	state.runVoiceToolLoop.mockResolvedValue({
		content: 'Hello, Captain. How can I help you today?'
	});
	state.runVoiceStreamingSpeak.mockResolvedValue({
		transcript: 'Hello, Captain. How can I help you today?',
		aborted: false,
		sentenceLog: []
	});
	state.registerTurn.mockReturnValue(undefined);
	state.unregisterTurn.mockReturnValue(undefined);
	state.randomUUID.mockReturnValue('mock-response-id');
});

async function postVoiceReply(body: Record<string, unknown>, env?: Record<string, string>) {
	if (env) {
		for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
	}
	vi.resetModules();
	const mod = await import('../src/routes/api/chat/voice-reply/+server');
	// Note: do NOT unstub env here — the handler reads process.env.VOICE_REPLY_STREAMING
	// at runtime, not at import time. Cleanup happens in the streaming describe's afterEach.
	return mod.POST({
		request: new Request('http://test.local/api/chat/voice-reply', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as Parameters<typeof mod.POST>[0]);
}

async function collectStream(res: Response): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return '';
	const decoder = new TextDecoder();
	let result = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		result += decoder.decode(value, { stream: true });
	}
	return result;
}

describe('voice-reply route — validation', () => {
	it('returns 400 for invalid JSON', async () => {
		const { POST } = await import('../src/routes/api/chat/voice-reply/+server');
		const res = await POST({
			request: new Request('http://test.local/api/chat/voice-reply', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'not json'
			})
		} as Parameters<typeof POST>[0]);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe('invalid json');
	});

	it('returns 400 for empty text', async () => {
		const res = await postVoiceReply({ text: '' });
		expect(res.status).toBe(400);
		expect(await res.text()).toBe('empty text');
	});

	it('strips leading STT punctuation noise before routing', async () => {
		state.prepareTurnLifecycle.mockImplementation(async ({ text, threadId, source }) => ({
			taskId: 'sully-test-task-001',
			currentTier: 'local',
			targetRepo: undefined,
			shadowDecision: { kind: 'ANSWER_NOW', reason: 'test' },
			userMessageText: text
		}));

		await postVoiceReply({ text: '! Whatever happened to Tiny Tiger?' });

		expect(state.prepareTurnLifecycle).toHaveBeenCalledWith({
			text: 'Whatever happened to Tiny Tiger?',
			threadId: 'default',
			source: 'voice',
			clientTurnId: null
		});
	});
});

describe('voice-reply route — non-streaming path (default)', () => {
	it('persists the reply and streams back plain text', async () => {
		const res = await postVoiceReply({ text: 'hello', thread: 'thread-abc' });

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');

		// prepareTurnLifecycle called with the operator's turn text
		expect(state.prepareTurnLifecycle).toHaveBeenCalledWith({
			text: 'hello',
			threadId: 'thread-abc',
			source: 'voice',
			clientTurnId: null
		});

		// runVoiceToolLoop called with the model + messages
		expect(state.runVoiceToolLoop).toHaveBeenCalled();
		const toolLoopArg = state.runVoiceToolLoop.mock.calls[0][0];
		expect(toolLoopArg.model).toBe('companion-v1-voice');

		// persistAssistantTurn called with the spoken reply
		expect(state.persistAssistantTurn).toHaveBeenCalledTimes(1);
		const persistArg = state.persistAssistantTurn.mock.calls[0][0];
		expect(persistArg.text).toBe('Hello, Captain. How can I help you today?');
		expect(persistArg.sender).toBe('local');
		expect(persistArg.threadId).toBe('thread-abc');
		expect(persistArg.model).toBe('companion-v1-voice');
		expect(persistArg.tier).toBe('local');
		expect(persistArg.taskId).toBe('sully-test-task-001');
		expect(persistArg.provider).toBe('local');

		// applyTurnDecision called after persistence
		expect(state.applyTurnDecision).toHaveBeenCalledTimes(1);
		const decisionArg = state.applyTurnDecision.mock.calls[0][0];
		expect(decisionArg).toEqual({ kind: 'ANSWER_NOW', reason: 'test' });

		// Stream contains the reply text
		const body = await collectStream(res);
		expect(body).toContain('Hello, Captain');
	});

	it('does not persist when the reply is empty', async () => {
		state.runVoiceToolLoop.mockResolvedValue({ content: '' });

		const res = await postVoiceReply({ text: 'hello' });

		expect(res.status).toBe(200);
		expect(state.persistAssistantTurn).not.toHaveBeenCalled();
	});

	it('calls needsFullReply to decide dispatch vs conversation', async () => {
		await postVoiceReply({ text: 'hello' });
		expect(state.needsFullReply).toHaveBeenCalledWith({ kind: 'ANSWER_NOW', reason: 'test' });
	});

	it('prepends system prompt and deduplicates consecutive same-role turns', async () => {
		state.getChatMessages.mockReturnValue([
			{ sender: 'operator', message: 'first message' },
			{ sender: 'operator', message: 'second message' }
		]);

		await postVoiceReply({ text: 'hello' });

		// Two consecutive user turns should be collapsed into one
		const toolLoopArg = state.runVoiceToolLoop.mock.calls[0][0];
		const userMsgs = toolLoopArg.messages.filter((m: { role: string }) => m.role === 'user');
		expect(userMsgs).toHaveLength(1);
		expect(userMsgs[0].content).toContain('first message');
		expect(userMsgs[0].content).toContain('second message');
	});

	it('errors from runVoiceToolLoop do not crash the route', async () => {
		state.runVoiceToolLoop.mockRejectedValue(new Error('model unreachable'));

		const res = await postVoiceReply({ text: 'hello' });
		expect(res.status).toBe(200);
		// No reply to persist — model never returned content
		expect(state.persistAssistantTurn).not.toHaveBeenCalled();
	});

	it('pre-stream dispatch path fires applyTurnDecision when needsFullReply is false', async () => {
		state.needsFullReply.mockReturnValue(false);

		await postVoiceReply({ text: 'dispatch this' });

		// applyTurnDecision called before the streaming reply
		const preDispatchCall = state.applyTurnDecision.mock.calls[0];
		expect(preDispatchCall[0]).toEqual({ kind: 'ANSWER_NOW', reason: 'test' });
		expect(preDispatchCall[1].suppressSpokenChatRow).toBe(true);
	});
});

describe('voice-reply route — streaming path (VOICE_REPLY_STREAMING=true)', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	it('persists the reply and returns SSE stream', async () => {
		const res = await postVoiceReply(
			{ text: 'hello', thread: 'thread-abc' },
			{ VOICE_REPLY_STREAMING: 'true' }
		);

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');

		// runVoiceStreamingSpeak called (not runVoiceToolLoop)
		expect(state.runVoiceStreamingSpeak).toHaveBeenCalled();
		expect(state.runVoiceToolLoop).not.toHaveBeenCalled();

		// persistAssistantTurn called with the spoken reply
		expect(state.persistAssistantTurn).toHaveBeenCalledTimes(1);
		const persistArg = state.persistAssistantTurn.mock.calls[0][0];
		expect(persistArg.text).toBe('Hello, Captain. How can I help you today?');
		expect(persistArg.status).toBeUndefined(); // not truncated

		// registerTurn / unregisterTurn called
		expect(state.registerTurn).toHaveBeenCalledWith(
			expect.objectContaining({ responseId: 'mock-response-id', threadId: 'thread-abc' })
		);
		expect(state.unregisterTurn).toHaveBeenCalledWith('mock-response-id');
	});

	it('persists as truncated when runVoiceStreamingSpeak reports abort with truncation', async () => {
		// Simulate the truncate endpoint having fired before the stream finishes:
		// registerTurn's triggerTruncate sets truncatedAt + aborts the generator.
		// We capture the triggerTruncate callback and call it to simulate the
		// barge-in before the mock streaming response is consumed.
		let triggerTruncate: ((ms: number) => boolean) | undefined;
		state.registerTurn.mockImplementation((opts: { triggerTruncate: (ms: number) => boolean }) => {
			triggerTruncate = opts.triggerTruncate;
		});
		state.runVoiceStreamingSpeak.mockImplementation(async () => {
			// Fire the truncation mid-stream (simulates the truncate endpoint)
			triggerTruncate?.(150);
			return {
				transcript: 'Hello, Captain. How',
				aborted: true,
				sentenceLog: [{ i: 0, text: 'Hello, Captain.', fired_ms: 100, audio_ms: 200 }]
			};
		});
		state.heardPrefixFromLog.mockReturnValue('Hello, Captain.');

		const res = await postVoiceReply({ text: 'hello' }, { VOICE_REPLY_STREAMING: 'true' });
		expect(res.status).toBe(200);

		// Persisted with status='truncated'
		expect(state.persistAssistantTurn).toHaveBeenCalledTimes(1);
		const persistArg = state.persistAssistantTurn.mock.calls[0][0];
		expect(persistArg.status).toBe('truncated');
		expect(persistArg.text).toBe('Hello, Captain.');
	});

	it('does not persist when aborted with no truncation (client disconnect)', async () => {
		state.runVoiceStreamingSpeak.mockResolvedValue({
			transcript: '',
			aborted: true,
			sentenceLog: []
		});

		await postVoiceReply({ text: 'hello' }, { VOICE_REPLY_STREAMING: 'true' });
		expect(state.persistAssistantTurn).not.toHaveBeenCalled();
	});

	it('dispatch_proposed SSE event emitted for dispatchable decisions', async () => {
		state.needsFullReply.mockReturnValue(false);
		state.prepareTurnLifecycle.mockResolvedValue({
			taskId: 'sully-test-task-001',
			currentTier: 'local',
			targetRepo: undefined,
			shadowDecision: {
				kind: 'DISPATCH',
				worker: 'cc',
				category: 'research',
				brief: 'test research',
				reason: 'test'
			},
			userMessageText: 'research this'
		});

		const res = await postVoiceReply({ text: 'research this' }, { VOICE_REPLY_STREAMING: 'true' });
		const body = await collectStream(res);
		expect(body).toContain('event: dispatch_proposed');
		expect(body).toContain('"agent":"cc"');
	});
});
