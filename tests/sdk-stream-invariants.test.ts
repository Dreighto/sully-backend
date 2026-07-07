import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';

const prepareStream = vi.fn();
const streamText = vi.fn();
const persistAssistantTurn = vi.fn();
const applyTurnDecision = vi.fn();
const deleteChatMessage = vi.fn();
const expireTaskById = vi.fn();

vi.mock('$lib/server/chat/stream_prepare', () => ({
	prepareStream
}));

vi.mock('$lib/server/chat_turn', () => ({
	persistAssistantTurn
}));

vi.mock('$lib/server/chat/autonomous_dispatch', () => ({
	applyTurnDecision
}));

vi.mock('$lib/server/chat', () => ({
	deleteChatMessage
}));

vi.mock('$lib/server/dispatchJobs', () => ({
	expireTaskById,
	markSelfHandled: vi.fn()
}));

vi.mock('$lib/server/model_catalog', () => ({
	resolveChatModel: () => 'gemini-test'
}));

vi.mock('@ai-sdk/google', () => ({
	createGoogleGenerativeAI: () => () => ({ provider: 'google-test-model' })
}));

vi.mock('@ai-sdk/anthropic', () => ({
	createAnthropic: () => () => ({ provider: 'anthropic-test-model' })
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
	createOpenAICompatible: () => () => ({ provider: 'openai-compatible-test-model' })
}));

vi.mock('$lib/server/routing/factGate', () => ({
	factGate: () => ({ category: 'conversational', sensitive: false, reason: 'test' })
}));

vi.mock('$lib/server/chat/base_tools', () => ({
	baseTools: {}
}));

vi.mock('$lib/server/chat/system_read_tools', () => ({
	systemReadTools: {}
}));

vi.mock('$lib/server/companion_tools', () => ({
	getSensitiveTools: () => ({})
}));

vi.mock('$lib/server/phase_classifier', () => ({}));
vi.mock('$lib/server/thread_state', () => ({
	upsertThreadTier: vi.fn()
}));
vi.mock('$lib/server/thread_meta', () => ({
	touchLastActivity: vi.fn()
}));
vi.mock('$lib/server/claude_cli_stream', () => ({
	streamViaClaudeCLI: vi.fn()
}));
vi.mock('$lib/server/chat/artifact_sentinel', () => ({
	extractAndPromoteArtifacts: vi.fn(),
	hasLiveArtifactSignal: vi.fn(),
	extractForPersist: vi.fn((text: string) => ({ text, artifactTraceId: null }))
}));
vi.mock('$lib/server/auto_title', () => ({
	maybeAutoTitle: vi.fn()
}));
vi.mock('$lib/server/gemini', () => ({
	generateGeminiImage: vi.fn()
}));
vi.mock('$lib/server/artifactStore', () => ({
	mintTeacherTraceId: () => 'artifact-test'
}));
vi.mock('$lib/server/routing/local_gate', () => ({
	LOCAL_GATE_INSTRUCTION: 'local gate',
	parseEscalation: () => null
}));
vi.mock('$lib/server/escalation_log', () => ({
	logEscalation: vi.fn(),
	updateEscalationCloudOutput: vi.fn()
}));
vi.mock('$lib/server/routing/pre_turn_router', () => ({
	preTurnRoute: () => ({ path: 'local', reason: 'test' })
}));

vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof import('ai')>('ai');
	return {
		...actual,
		streamText,
		convertToModelMessages: vi.fn(async (messages) => messages),
		stepCountIs: vi.fn(() => () => false),
		generateId: vi.fn(() => 'msg-test')
	};
});

type ToUIMessageStreamOptions = {
	onError: (error: unknown) => string;
	onFinish: (event: { responseMessage: { parts: unknown[] } }) => Promise<void>;
};

const message: UIMessage = {
	id: 'user-1',
	role: 'user',
	parts: [{ type: 'text', text: 'hello sully' }]
} as UIMessage;

function context(overrides: Partial<Awaited<ReturnType<typeof prepareStream>>> = {}) {
	return {
		messages: [message],
		threadId: 'thread-test',
		taskId: 'task-test',
		userText: 'hello sully',
		operatorRowId: 42,
		reused: false,
		currentTier: 'chat',
		threadState: {},
		targetRepo: 'companion',
		autoMode: false,
		provider: 'google',
		resolvedModelId: 'gemini-test',
		useClaudeCLI: false,
		allowSensitive: false,
		systemPrompt: 'system',
		modelMessages: [message],
		mutationGate: { classification: 'NONE', activeTaskId: null },
		shadowDecision: { kind: 'ANSWER_NOW', reason: 'test' },
		...overrides
	};
}

async function postSdkStream() {
	const { POST } = await import('../src/routes/api/chat/sdk-stream/+server');
	return POST({
		request: new Request('http://test.local/api/chat/sdk-stream', {
			method: 'POST',
			body: JSON.stringify({ messages: [message], thread: 'thread-test', provider: 'google' }),
			headers: { 'Content-Type': 'application/json' }
		})
	} as Parameters<typeof POST>[0]);
}

async function responseChunks(response: Response) {
	const text = await response.text();
	return text
		.split('\n\n')
		.map((frame) => frame.trim())
		.filter((frame) => frame.startsWith('data: '))
		.map((frame) => frame.slice('data: '.length))
		.filter((data) => data !== '[DONE]')
		.map((data) => JSON.parse(data) as { type: string; [key: string]: unknown });
}

function mockHappyDirectStream(replyText = 'Hello back.') {
	const chunks = [
		{ type: 'start', messageId: 'sdk-msg' },
		{ type: 'start-step' },
		{ type: 'text-start', id: '0' },
		{ type: 'text-delta', id: '0', delta: replyText },
		{ type: 'text-end', id: '0' },
		{ type: 'finish-step' }
	];
	streamText.mockReturnValue({
		usage: Promise.resolve({ inputTokens: 3, outputTokens: 2 }),
		finishReason: Promise.resolve('stop'),
		toUIMessageStream: ({ onFinish }: ToUIMessageStreamOptions) =>
			new ReadableStream({
				async pull(controller) {
					const next = chunks.shift();
					if (next) {
						controller.enqueue(next);
						return;
					}
					await onFinish({
						responseMessage: { parts: [{ type: 'text', text: replyText }] }
					});
					controller.close();
				}
			})
	});
}

function mockEmptySuccessfulDirectStream() {
	const chunks = [{ type: 'start', messageId: 'sdk-msg' }, { type: 'finish-step' }];
	streamText.mockReturnValue({
		usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
		finishReason: Promise.resolve('stop'),
		toUIMessageStream: ({ onFinish }: ToUIMessageStreamOptions) =>
			new ReadableStream({
				async pull(controller) {
					const next = chunks.shift();
					if (next) {
						controller.enqueue(next);
						return;
					}
					await onFinish({ responseMessage: { parts: [] } });
					controller.close();
				}
			})
	});
}

function mockErroredDirectStream() {
	const chunks = [
		{ type: 'start', messageId: 'sdk-msg' },
		{ type: 'error', errorText: '' }
	];
	streamText.mockReturnValue({
		usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
		finishReason: Promise.resolve('error'),
		toUIMessageStream: ({ onError, onFinish }: ToUIMessageStreamOptions) =>
			new ReadableStream({
				async pull(controller) {
					const next = chunks.shift();
					if (next) {
						controller.enqueue(
							next.type === 'error'
								? { type: 'error', errorText: onError(new Error('provider failed')) }
								: next
						);
						return;
					}
					await onFinish({ responseMessage: { parts: [] } });
					controller.close();
				}
			})
	});
}

beforeEach(() => {
	vi.resetModules();
	process.env.GEMINI_API_KEY = 'test-gemini-key';
	prepareStream.mockResolvedValue(context());
	persistAssistantTurn.mockReturnValue(777);
	applyTurnDecision.mockResolvedValue({});
	deleteChatMessage.mockReset();
	expireTaskById.mockReset();
	streamText.mockReset();
	persistAssistantTurn.mockClear();
	applyTurnDecision.mockClear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('POST /api/chat/sdk-stream invariants', () => {
	it('emits reply-id after streamed text and before finish on a happy direct turn', async () => {
		mockHappyDirectStream();

		const response = await postSdkStream();
		expect(response.status).toBe(200);
		const chunks = await responseChunks(response);
		const types = chunks.map((chunk) => chunk.type);

		expect(types).toEqual([
			'data-sully-routing',
			'start',
			'start-step',
			'text-start',
			'text-delta',
			'text-end',
			'finish-step',
			'data-sully-reply-id',
			'finish'
		]);
		expect(chunks.at(-2)).toEqual({ type: 'data-sully-reply-id', data: { id: 777 } });
		expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
		expect(applyTurnDecision).toHaveBeenCalledTimes(1);
	});

	it('rolls back and does not dispatch an errored empty direct turn', async () => {
		mockErroredDirectStream();

		const response = await postSdkStream();
		expect(response.status).toBe(200);
		const chunks = await responseChunks(response);
		const types = chunks.map((chunk) => chunk.type);

		// Typed error frame is emitted IN ADDITION to the SDK-standard error part.
		expect(types).toEqual(['data-sully-routing', 'start', 'data-sully-error', 'error', 'finish']);
		const errFrame = chunks.find((chunk) => chunk.type === 'data-sully-error');
		expect(errFrame?.data).toEqual({
			code: 'unknown',
			message: 'provider failed',
			recovery: expect.stringMatching(/retry|switch model/i)
		});
		expect(persistAssistantTurn).not.toHaveBeenCalled();
		expect(deleteChatMessage).toHaveBeenCalledWith(42);
		expect(expireTaskById).toHaveBeenCalledWith('task-test');
		expect(applyTurnDecision).not.toHaveBeenCalled();
	});

	it('does not roll back a reused errored empty direct turn', async () => {
		prepareStream.mockResolvedValue(context({ reused: true }));
		mockErroredDirectStream();

		const response = await postSdkStream();
		expect(response.status).toBe(200);
		await responseChunks(response);

		expect(persistAssistantTurn).not.toHaveBeenCalled();
		expect(deleteChatMessage).not.toHaveBeenCalled();
		expect(expireTaskById).not.toHaveBeenCalled();
		expect(applyTurnDecision).not.toHaveBeenCalled();
	});

	it('rolls back a successful-looking empty direct turn with no reply text', async () => {
		mockEmptySuccessfulDirectStream();

		const response = await postSdkStream();
		expect(response.status).toBe(200);
		const chunks = await responseChunks(response);
		const types = chunks.map((chunk) => chunk.type);

		expect(types).toEqual([
			'data-sully-routing',
			'start',
			'finish-step',
			'data-sully-error',
			'finish'
		]);
		expect(chunks.find((chunk) => chunk.type === 'data-sully-error')?.data).toEqual({
			code: 'unknown',
			message: 'No reply was generated.',
			recovery: expect.stringMatching(/retry|switch model/i)
		});
		expect(persistAssistantTurn).not.toHaveBeenCalled();
		expect(deleteChatMessage).toHaveBeenCalledWith(42);
		expect(expireTaskById).toHaveBeenCalledWith('task-test');
		expect(applyTurnDecision).not.toHaveBeenCalled();
	});
});
