import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
	const runMode = {
		mode: 'companion',
		companion: true,
		kernelWired: false,
		dispatchEnabled: false,
		observationsEnabled: false,
		gatewayWorkspaces: false,
		completionPoller: false,
		killSwitchEnabled: false,
		companionDispatchEnabled: false
	};
	const serverConfig = {
		gatewayUrl: 'http://gateway.test',
		mode: 'companion'
	};
	const operatorRow = {
		id: 101,
		sender: 'operator',
		message: 'unset',
		trace_id: null,
		ticket_id: null,
		interactive_action: null,
		status: 'sent',
		timestamp: '2026-07-04 00:00:00',
		thread_id: 'thread-test',
		quality_signal: null,
		client_turn_id: null
	};
	return {
		runMode,
		serverConfig,
		operatorRow,
		getChatMessages: vi.fn(),
		addChatMessage: vi.fn(),
		deleteChatMessage: vi.fn(),
		persistUserTurn: vi.fn(),
		classifyAndTouchThread: vi.fn(),
		mintTaskId: vi.fn(),
		maybeMarkDeepCandidate: vi.fn(),
		emitDispatchLinkObservation: vi.fn(),
		dispatchToWorker: vi.fn(),
		callHermes: vi.fn(),
		chatRowsToHermesHistory: vi.fn(),
		routeChat: vi.fn(),
		generateGeminiImage: vi.fn(),
		buildMultimodalContent: vi.fn(),
		buildSystemPrompt: vi.fn(),
		detectTargetRepo: vi.fn(),
		upsertThreadTier: vi.fn()
	};
});

vi.mock('$lib/server/config', () => ({
	runMode: state.runMode,
	serverConfig: state.serverConfig
}));

vi.mock('$lib/server/chat', () => ({
	getChatMessages: state.getChatMessages,
	addChatMessage: state.addChatMessage,
	deleteChatMessage: state.deleteChatMessage
}));

vi.mock('$lib/server/chat_turn', () => ({
	persistUserTurn: state.persistUserTurn,
	classifyAndTouchThread: state.classifyAndTouchThread,
	persistAssistantTurn: vi.fn(),
	mintTaskId: state.mintTaskId
}));

vi.mock('$lib/server/observation_emit', () => ({
	maybeMarkDeepCandidate: state.maybeMarkDeepCandidate,
	emitDispatchLinkObservation: state.emitDispatchLinkObservation
}));

vi.mock('$lib/server/companionDispatch', () => ({
	dispatchToWorker: state.dispatchToWorker
}));

vi.mock('$lib/server/hermes', () => ({
	callHermes: state.callHermes,
	chatRowsToHermesHistory: state.chatRowsToHermesHistory
}));

vi.mock('$lib/server/llm_router', () => ({
	routeChat: state.routeChat
}));

vi.mock('$lib/server/gemini', () => ({
	generateGeminiImage: state.generateGeminiImage
}));

vi.mock('$lib/server/multimodal', () => ({
	buildMultimodalContent: state.buildMultimodalContent
}));

vi.mock('$lib/server/chat_prompt', () => ({
	buildSystemPrompt: state.buildSystemPrompt
}));

vi.mock('$lib/server/chat/stream_prepare', () => ({
	detectTargetRepo: state.detectTargetRepo
}));

vi.mock('$lib/server/thread_state', () => ({
	upsertThreadTier: state.upsertThreadTier
}));

async function postChat(body: Record<string, unknown>) {
	const { POST } = await import('../src/routes/api/chat/+server');
	return POST({
		request: new Request('http://test.local/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as Parameters<typeof POST>[0]);
}

async function jsonBody(response: Response) {
	return (await response.json()) as Record<string, unknown>;
}

function setRunMode(mode: 'companion' | 'wired', companionDispatchEnabled = false) {
	Object.assign(state.runMode, {
		mode,
		companion: mode === 'companion',
		kernelWired: mode !== 'companion',
		dispatchEnabled: mode !== 'companion',
		observationsEnabled: mode !== 'companion',
		gatewayWorkspaces: mode !== 'companion',
		completionPoller: mode !== 'companion',
		killSwitchEnabled: mode !== 'companion',
		companionDispatchEnabled
	});
	state.serverConfig.mode = mode;
}

beforeEach(() => {
	vi.resetModules();
	vi.restoreAllMocks();
	for (const mock of [
		state.getChatMessages,
		state.addChatMessage,
		state.deleteChatMessage,
		state.persistUserTurn,
		state.classifyAndTouchThread,
		state.mintTaskId,
		state.maybeMarkDeepCandidate,
		state.emitDispatchLinkObservation,
		state.dispatchToWorker,
		state.callHermes,
		state.chatRowsToHermesHistory,
		state.routeChat,
		state.generateGeminiImage,
		state.buildMultimodalContent,
		state.buildSystemPrompt,
		state.detectTargetRepo,
		state.upsertThreadTier
	]) {
		mock.mockReset();
	}
	setRunMode('companion', false);
	state.operatorRow.message = 'Plan the refactor.';
	state.operatorRow.thread_id = 'thread-test';
	state.mintTaskId.mockReturnValue('task-test');
	state.persistUserTurn.mockImplementation(({ text, threadId }) => ({
		row: { ...state.operatorRow, message: text, thread_id: threadId },
		taskId: 'task-test',
		reused: false
	}));
	state.classifyAndTouchThread.mockReturnValue({
		currentTier: 'chat',
		threadState: { current_tier: 'chat', operator_override: null }
	});
	state.getChatMessages.mockImplementation((_limit, threadId) => [
		{ ...state.operatorRow, message: 'Previous reply.', sender: 'agy', thread_id: threadId },
		{
			...state.operatorRow,
			message: state.operatorRow.message,
			sender: 'operator',
			thread_id: threadId
		}
	]);
	state.addChatMessage.mockImplementation(
		(sender, message, traceId, ticketId, action, status, threadId) => ({
			id: 202,
			sender,
			message,
			trace_id: traceId ?? null,
			ticket_id: ticketId ?? null,
			interactive_action: action ?? null,
			status,
			timestamp: '2026-07-04 00:00:01',
			thread_id: threadId
		})
	);
	state.detectTargetRepo.mockReturnValue('companion');
	state.buildMultimodalContent.mockImplementation(async (text) => text);
	state.buildSystemPrompt.mockResolvedValue('system prompt');
	state.routeChat.mockResolvedValue({
		reply: 'Planning reply.',
		provider_used: 'google',
		model_used: 'gemini-test',
		fell_forward: false
	});
	state.callHermes.mockResolvedValue('Hermes reply.');
	state.chatRowsToHermesHistory.mockReturnValue([{ role: 'user', content: 'history' }]);
	state.generateGeminiImage.mockResolvedValue({ url: '/generated/test.png' });
	state.dispatchToWorker.mockResolvedValue({ ok: true });
	vi.stubGlobal('fetch', vi.fn());
});

describe('legacy /api/chat mode routing', () => {
	it('routes a plain conversational turn through chat only and does not dispatch', async () => {
		const response = await postChat({
			sender: 'operator',
			message: 'Plan the refactor with me',
			thread: 'thread-chat'
		});
		const body = await jsonBody(response);

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			current_tier: 'chat',
			provider_used: 'google',
			model_used: 'gemini-test'
		});
		expect(body.message).toMatchObject({ sender: 'operator', thread_id: 'thread-chat' });
		expect(state.routeChat).toHaveBeenCalledTimes(1);
		expect(state.dispatchToWorker).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(state.generateGeminiImage).not.toHaveBeenCalled();
		expect(state.callHermes).not.toHaveBeenCalled();
		expect(state.addChatMessage).toHaveBeenCalledWith(
			'agy',
			'Planning reply.',
			null,
			null,
			null,
			'sent',
			'thread-chat'
		);
	});

	it('sends an @cc turn through companion-native dispatch when that gate is enabled', async () => {
		setRunMode('companion', true);
		const response = await postChat({
			sender: 'operator',
			message: '@cc fix the backend route',
			thread: 'thread-dispatch'
		});
		const body = await jsonBody(response);

		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true, trace_id: 'task-test' });
		expect(state.dispatchToWorker).toHaveBeenCalledWith(
			expect.objectContaining({
				traceId: 'task-test',
				worker: 'claude-code',
				targetRepo: 'companion',
				task: '@cc fix the backend route',
				threadId: 'thread-dispatch'
			})
		);
		expect(state.addChatMessage).toHaveBeenCalledWith(
			'system',
			'Handing this to CC.',
			'task-test',
			null,
			null,
			'sent',
			'thread-dispatch'
		);
		expect(state.routeChat).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('short-circuits image mode into image generation with the existing response shape', async () => {
		const response = await postChat({
			sender: 'operator',
			message: 'draw a workspace dashboard',
			thread: 'thread-image',
			image: true
		});
		const body = await jsonBody(response);

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ current_tier: 'chat' });
		expect(state.generateGeminiImage).toHaveBeenCalledWith('draw a workspace dashboard');
		expect(state.addChatMessage).toHaveBeenCalledWith(
			'agy',
			'![draw a workspace dashboard](/generated/test.png)',
			null,
			null,
			null,
			'sent',
			'thread-image'
		);
		expect(state.routeChat).not.toHaveBeenCalled();
		expect(state.dispatchToWorker).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('routes the Hermes pill to Hermes only and keeps the normal POST response shape', async () => {
		const response = await postChat({
			sender: 'operator',
			message: 'think this through',
			thread: 'thread-hermes',
			agent: 'hermes'
		});
		const body = await jsonBody(response);

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ current_tier: 'chat' });
		expect(state.callHermes).toHaveBeenCalledWith(
			[{ role: 'user', content: 'history' }],
			'think this through'
		);
		expect(state.addChatMessage).toHaveBeenCalledWith(
			'hermes',
			'Hermes reply.',
			null,
			null,
			null,
			'sent',
			'thread-hermes'
		);
		expect(state.routeChat).not.toHaveBeenCalled();
		expect(state.dispatchToWorker).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('sends an explicit worker turn through kernel gateway dispatch in wired mode', async () => {
		setRunMode('wired');
		(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(JSON.stringify({ trace_id: 'kernel-trace' }), { status: 200 })
		);

		const response = await postChat({
			sender: 'operator',
			message: '@agy build the workspace artifact',
			thread: 'thread-kernel',
			ticket_id: 'SUL-999'
		});
		const body = await jsonBody(response);

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ current_tier: 'chat' });
		expect(state.dispatchToWorker).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledWith(
			'http://gateway.test/api/v1/dispatch',
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			})
		);
		const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(JSON.parse(String(init.body))).toMatchObject({
			tool_profile: 'standard_worker',
			worker: 'agy',
			target_repo: 'companion',
			ticket_id: 'SUL-999',
			thinking_level: 'none',
			model: 'claude-sonnet-4-6'
		});
		expect(state.addChatMessage).toHaveBeenCalledWith(
			'system',
			'Agent dispatched: **agy** is spinning up to handle this request on **companion**. (Trace ID: kernel-trace)',
			'kernel-trace',
			'SUL-999',
			null,
			'sent',
			'thread-kernel'
		);
		expect(state.routeChat).not.toHaveBeenCalled();
	});
});
