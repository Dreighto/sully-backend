// Resumable sdk-stream coverage: while a direct turn generates, its UIMessage
// chunks are buffered per thread (sdk_stream_common); GET
// /api/chat/sdk-stream/resume?thread=X&startIndex=N replays from startIndex
// then continues live until finish, and returns 204 when no stream is active
// (idle, finished, errored, or rolled back).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage, UIMessageChunk } from 'ai';

const prepareStream = vi.fn();
const streamText = vi.fn();
const streamViaClaudeCLI = vi.fn();
const extractAndPromoteArtifacts = vi.fn(() => ({ strippedText: '', artifacts: [] }));
const hasLiveArtifactSignal = vi.fn(() => false);
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
	streamViaClaudeCLI
}));
vi.mock('$lib/server/chat/artifact_sentinel', () => ({
	extractAndPromoteArtifacts,
	hasLiveArtifactSignal
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

async function importCommon() {
	return import('../src/lib/server/chat/sdk_stream_common');
}

async function getResume(query: string) {
	const { GET } = await import('../src/routes/api/chat/sdk-stream/resume/+server');
	return GET({
		url: new URL(`http://test.local/api/chat/sdk-stream/resume${query}`)
	} as Parameters<typeof GET>[0]);
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

async function postSdkStreamWithContext(
	ctxOverrides: Partial<Awaited<ReturnType<typeof prepareStream>>>
) {
	prepareStream.mockResolvedValue(context(ctxOverrides));
	return postSdkStream();
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

/** Direct-stream mock that emits `head` chunks freely, then waits on `gate`
 * before emitting the tail — lets a test attach a resume mid-turn. */
function mockGatedDirectStream(gate: Promise<void>, replyText = 'Resumed reply.') {
	const head = [
		{ type: 'start', messageId: 'sdk-msg' },
		{ type: 'start-step' },
		{ type: 'text-start', id: '0' }
	];
	const tail = [
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
					const eager = head.shift();
					if (eager) {
						controller.enqueue(eager);
						return;
					}
					await gate;
					const late = tail.shift();
					if (late) {
						controller.enqueue(late);
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

function mockGatedCliStream(gate: Promise<void>, replyText = 'Complete durable CLI reply.') {
	streamViaClaudeCLI.mockImplementation(async function* () {
		yield { type: 'text-delta', delta: 'CLI head. ' };
		await gate;
		yield { type: 'text-delta', delta: replyText.replace(/^CLI head\. /, '') };
	});
}

function mockGatedLocalStream(gate: Promise<void>, replyText: string) {
	const parts = [
		{ type: 'text-delta', text: replyText.slice(0, 130) },
		{ type: 'text-delta', text: replyText.slice(130) }
	];
	streamText.mockReturnValue({
		fullStream: (async function* () {
			const first = parts.shift();
			if (first) yield first;
			await gate;
			const second = parts.shift();
			if (second) yield second;
		})()
	});
}

function mockErroredLocalStreamAfterText(replyText: string) {
	streamText.mockReturnValue({
		fullStream: (async function* () {
			yield { type: 'text-delta', text: replyText };
			throw new Error('local socket reset');
		})()
	});
}

function mockNeverFinishingDirectStream() {
	streamText.mockImplementation((options) => ({
		usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
		finishReason: Promise.resolve('error'),
		toUIMessageStream: ({ onError, onFinish }: ToUIMessageStreamOptions) =>
			new ReadableStream({
				start(controller) {
					controller.enqueue({ type: 'start', messageId: 'sdk-msg' });
					options.abortSignal?.addEventListener(
						'abort',
						async () => {
							controller.enqueue({
								type: 'error',
								errorText: onError(new Error('superseded'))
							});
							await onFinish({ responseMessage: { parts: [] } });
							controller.close();
						},
						{ once: true }
					);
				}
			})
	}));
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
	streamViaClaudeCLI.mockReset();
	extractAndPromoteArtifacts.mockReset();
	extractAndPromoteArtifacts.mockReturnValue({ strippedText: '', artifacts: [] });
	hasLiveArtifactSignal.mockReset();
	hasLiveArtifactSignal.mockReturnValue(false);
	persistAssistantTurn.mockClear();
	applyTurnDecision.mockClear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('GET /api/chat/sdk-stream/resume', () => {
	it('returns 204 when no stream is active for the thread', async () => {
		const response = await getResume('?thread=thread-idle&startIndex=0');
		expect(response.status).toBe(204);
		expect(await response.text()).toBe('');
	});

	it('replays buffered chunks from startIndex then continues live until finish', async () => {
		const common = await importCommon();
		const handle = common.beginActiveStream('thread-replay');
		handle.record({ type: 'start', messageId: 'm1' } as UIMessageChunk);
		handle.record({ type: 'text-start', id: '0' } as UIMessageChunk);
		handle.record({ type: 'text-delta', id: '0', delta: 'buffered ' } as UIMessageChunk);

		const response = await getResume('?thread=thread-replay&startIndex=1');
		expect(response.status).toBe(200);

		// Live continuation after the resume attached.
		handle.record({ type: 'text-delta', id: '0', delta: 'live' } as UIMessageChunk);
		handle.record({ type: 'text-end', id: '0' } as UIMessageChunk);
		handle.record({ type: 'finish', finishReason: 'stop' } as UIMessageChunk);
		handle.end();

		const chunks = await responseChunks(response);
		expect(chunks.map((chunk) => chunk.type)).toEqual([
			'text-start', // startIndex=1 skips the buffered 'start'
			'text-delta',
			'text-delta',
			'text-end',
			'finish'
		]);
		expect(chunks[1]).toEqual({ type: 'text-delta', id: '0', delta: 'buffered ' });
		expect(chunks[2]).toEqual({ type: 'text-delta', id: '0', delta: 'live' });
	});

	it('signals a gap when a resume predates the ring-buffer base (WI-10b)', async () => {
		const common = await importCommon();
		const handle = common.beginActiveStream('thread-gap');
		// Overflow the ring buffer so its base advances past index 0: the OLDEST
		// chunks get dropped, so a resume from 0 can never see them.
		const TOTAL = 4096 + 50; // MAX_BUFFERED_CHUNKS + overflow
		for (let i = 0; i < TOTAL; i++) {
			handle.record({ type: 'text-delta', id: '0', delta: `c${i}` } as UIMessageChunk);
		}

		const seen: UIMessageChunk[] = [];
		const unsub = common.subscribeToActiveStream('thread-gap', 0, {
			onChunk: (chunk: UIMessageChunk) => seen.push(chunk),
			onDone: () => {}
		});
		expect(unsub).not.toBeNull();

		// First replayed chunk must be the gap marker — the client uses it to
		// discard its holed streamed row and reconcile the final text from history.
		const gap = seen[0] as unknown as {
			type: string;
			data: { droppedChunks: number; resumedAtIndex: number; requestedFrom: number };
		};
		expect(gap.type).toBe('data-sully-gap');
		expect(gap.data.requestedFrom).toBe(0);
		expect(gap.data.droppedChunks).toBe(50);
		expect(gap.data.resumedAtIndex).toBe(50);
		// No gap marker when the resume is within the retained window.
		const seen2: UIMessageChunk[] = [];
		common.subscribeToActiveStream('thread-gap', 4100, {
			onChunk: (chunk: UIMessageChunk) => seen2.push(chunk),
			onDone: () => {}
		});
		expect(seen2.every((c) => (c as { type: string }).type !== 'data-sully-gap')).toBe(true);

		unsub?.();
		handle.end();
	});

	it('returns 204 after the active stream ended (cleared on finish)', async () => {
		const common = await importCommon();
		const handle = common.beginActiveStream('thread-done');
		handle.record({ type: 'start', messageId: 'm1' } as UIMessageChunk);
		handle.end();

		const response = await getResume('?thread=thread-done');
		expect(response.status).toBe(204);
		expect(common.hasActiveStream('thread-done')).toBe(false);
	});

	it('resumes a live direct turn mid-generation and receives the tail through finish', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		mockGatedDirectStream(gate);

		const postResponse = await postSdkStream();
		expect(postResponse.status).toBe(200);

		// Wait until the head chunks are buffered, then attach a resume from index 1.
		const common = await importCommon();
		await vi.waitFor(() => {
			expect(common.hasActiveStream('thread-test')).toBe(true);
			const seen: string[] = [];
			const unsubscribe = common.subscribeToActiveStream('thread-test', 0, {
				onChunk: (chunk) => seen.push(chunk.type),
				onDone: () => {}
			});
			unsubscribe?.();
			expect(seen.length).toBeGreaterThanOrEqual(3);
		});

		const resumeResponse = await getResume('?thread=thread-test&startIndex=1');
		expect(resumeResponse.status).toBe(200);

		release();

		const [postChunks, resumeChunks] = await Promise.all([
			responseChunks(postResponse),
			responseChunks(resumeResponse)
		]);

		expect(postChunks.map((chunk) => chunk.type)).toEqual([
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
		// Resume replays from startIndex=1 (skips routing) and rides the live tail to finish.
		expect(resumeChunks.map((chunk) => chunk.type)).toEqual([
			'start',
			'start-step',
			'text-start',
			'text-delta',
			'text-end',
			'finish-step',
			'data-sully-reply-id',
			'finish'
		]);
		expect(resumeChunks.at(-2)).toEqual({ type: 'data-sully-reply-id', data: { id: 777 } });
		expect(resumeChunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });

		// Cleared on finish: a fresh resume now reports no active stream.
		expect(common.hasActiveStream('thread-test')).toBe(false);
		const idle = await getResume('?thread=thread-test&startIndex=0');
		expect(idle.status).toBe(204);
	});

	it('keeps generating when the original response listener is gone, then resume replays the full buffered reply', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const replyText = 'Complete durable reply.';
		mockGatedDirectStream(gate, replyText);

		const postResponse = await postSdkStream();
		expect(postResponse.status).toBe(200);

		const common = await importCommon();
		await vi.waitFor(() => {
			expect(common.hasActiveStream('thread-test')).toBe(true);
		});

		// Simulate adapter-node throwing while writing to the original POST after
		// the client socket disappeared. The listener must be detached, not allowed
		// to throw back into the model pump.
		common.subscribeToActiveStream('thread-test', 0, {
			onChunk: () => {
				throw new Error('client socket closed');
			},
			onDone: () => {
				throw new Error('client socket closed');
			}
		});

		const resumeResponse = await getResume('?thread=thread-test&startIndex=0');
		expect(resumeResponse.status).toBe(200);

		release();

		const chunks = await responseChunks(resumeResponse);
		expect(chunks.map((chunk) => chunk.type)).toEqual([
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
		expect(chunks.find((chunk) => chunk.type === 'text-delta')).toEqual({
			type: 'text-delta',
			id: '0',
			delta: replyText
		});
		expect(persistAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({ text: replyText }));
		expect(common.hasActiveStream('thread-test')).toBe(false);
		const idle = await getResume('?thread=thread-test&startIndex=0');
		expect(idle.status).toBe(204);

		await postResponse.body?.cancel().catch(() => {});
	});

	it('keeps a CLI turn generating after the original client disconnects, then resume replays and clears on finish', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		mockGatedCliStream(gate);

		const postResponse = await postSdkStreamWithContext({
			useClaudeCLI: true,
			provider: 'anthropic',
			resolvedModelId: 'claude-cli-test'
		});
		expect(postResponse.status).toBe(200);

		const common = await importCommon();
		await vi.waitFor(() => {
			expect(common.hasActiveStream('thread-test')).toBe(true);
		});
		await postResponse.body?.cancel().catch(() => {});

		const resumeResponse = await getResume('?thread=thread-test&startIndex=0');
		expect(resumeResponse.status).toBe(200);
		release();

		const chunks = await responseChunks(resumeResponse);
		const text = chunks
			.filter((chunk) => chunk.type === 'text-delta')
			.map((chunk) => chunk.delta)
			.join('');
		expect(text).toBe('CLI head. Complete durable CLI reply.');
		expect(chunks.at(-2)).toEqual({ type: 'data-sully-reply-id', data: { id: 777 } });
		expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
		expect(persistAssistantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ text: 'CLI head. Complete durable CLI reply.' })
		);
		expect(common.hasActiveStream('thread-test')).toBe(false);
		expect((await getResume('?thread=thread-test&startIndex=0')).status).toBe(204);
	});

	it('keeps a Local turn generating after the original client disconnects, then resume replays and clears on finish', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const replyText =
			'Local durable reply '.repeat(8) + 'tail that arrives after the socket disconnects.';
		mockGatedLocalStream(gate, replyText);

		const postResponse = await postSdkStreamWithContext({
			provider: 'local',
			currentTier: 'local',
			resolvedModelId: 'qwen-local-test'
		});
		expect(postResponse.status).toBe(200);

		const common = await importCommon();
		await vi.waitFor(() => {
			expect(common.hasActiveStream('thread-test')).toBe(true);
		});
		await postResponse.body?.cancel().catch(() => {});

		const resumeResponse = await getResume('?thread=thread-test&startIndex=0');
		expect(resumeResponse.status).toBe(200);
		release();

		const chunks = await responseChunks(resumeResponse);
		const text = chunks
			.filter((chunk) => chunk.type === 'text-delta')
			.map((chunk) => chunk.delta)
			.join('');
		expect(text).toBe(replyText);
		expect(chunks.at(-2)).toEqual({ type: 'data-sully-reply-id', data: { id: 777 } });
		expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
		expect(persistAssistantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ text: replyText, sender: 'local' })
		);
		expect(common.hasActiveStream('thread-test')).toBe(false);
		expect((await getResume('?thread=thread-test&startIndex=0')).status).toBe(204);
	});

	it('persists partial Local text as truncated on a mid-stream error instead of leaving an orphan task', async () => {
		const partialText = 'Partial local reply before failure.';
		mockErroredLocalStreamAfterText(partialText);

		const response = await postSdkStreamWithContext({
			provider: 'local',
			currentTier: 'local',
			resolvedModelId: 'qwen-local-test'
		});
		expect(response.status).toBe(200);

		const chunks = await responseChunks(response);
		expect(chunks.at(-2)).toEqual({ type: 'data-sully-reply-id', data: { id: 777 } });
		expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'error' });
		expect(persistAssistantTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				text: partialText,
				sender: 'local',
				status: 'truncated',
				error: expect.stringContaining('local socket reset')
			})
		);
		expect(deleteChatMessage).not.toHaveBeenCalled();
		expect(expireTaskById).not.toHaveBeenCalled();
		expect(applyTurnDecision).not.toHaveBeenCalled();
	});

	it('aborts the server-side model controller when a new turn supersedes the same thread', async () => {
		mockNeverFinishingDirectStream();

		const postResponse = await postSdkStream();
		expect(postResponse.status).toBe(200);

		const common = await importCommon();
		await vi.waitFor(() => {
			expect(common.hasActiveStream('thread-test')).toBe(true);
		});
		const firstCall = streamText.mock.calls[0]?.[0];
		expect(firstCall?.abortSignal).toBeInstanceOf(AbortSignal);
		expect(firstCall.abortSignal.aborted).toBe(false);

		const superseding = common.beginActiveStream('thread-test');
		expect(firstCall.abortSignal.aborted).toBe(true);
		superseding.end();

		await postResponse.body?.cancel().catch(() => {});
	});
});
