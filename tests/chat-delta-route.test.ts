// Locks the GET /api/chat delta short-circuit at the route layer: `since`
// routes to getChatMessagesSince and adds {latest_id, thread_updated} meta;
// omitting `since` keeps the original full-window {messages} shape
// (backward compatible); a malformed `since` is rejected with a 400.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	getChatMessages: vi.fn(),
	getChatMessagesSince: vi.fn(),
	deleteChatMessage: vi.fn()
}));

vi.mock('$lib/server/chat', () => ({
	getChatMessages: state.getChatMessages,
	getChatMessagesSince: state.getChatMessagesSince,
	deleteChatMessage: state.deleteChatMessage
}));

// The route module also pulls in the POST-path plumbing at import time —
// stub it all out so the GET tests exercise the router in isolation.
vi.mock('$lib/server/config', () => ({
	runMode: { dispatchEnabled: false },
	serverConfig: { mode: 'companion' }
}));
vi.mock('$lib/server/chat/legacy_context', () => ({ buildChatPostContext: vi.fn() }));
vi.mock('$lib/server/chat/legacy_companion_dispatch', () => ({
	handleCompanionDispatch: vi.fn()
}));
vi.mock('$lib/server/chat/legacy_conversation', () => ({ handleConversationalChat: vi.fn() }));
vi.mock('$lib/server/chat/legacy_hermes', () => ({ handleHermes: vi.fn() }));
vi.mock('$lib/server/chat/legacy_image', () => ({ handleImageGeneration: vi.fn() }));
vi.mock('$lib/server/chat/legacy_kernel_dispatch', () => ({ handleKernelDispatch: vi.fn() }));

async function getChat(query: string) {
	const { GET } = await import('../src/routes/api/chat/+server');
	return GET({
		url: new URL(`http://test.local/api/chat${query}`)
	} as Parameters<typeof GET>[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	state.getChatMessages.mockReturnValue([]);
	state.getChatMessagesSince.mockReturnValue({
		messages: [],
		latest_id: 0,
		thread_updated: null
	});
});

describe('GET /api/chat delta short-circuit', () => {
	it('without since: full-window fetch, original {messages} shape (backward compatible)', async () => {
		const rows = [{ id: 1 }, { id: 2 }];
		state.getChatMessages.mockReturnValue(rows);
		const res = await getChat('?thread=thread-a');
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(state.getChatMessages).toHaveBeenCalledWith(50, 'thread-a');
		expect(state.getChatMessagesSince).not.toHaveBeenCalled();
		expect(body).toEqual({ messages: rows });
		expect(body).not.toHaveProperty('latest_id');
		expect(body).not.toHaveProperty('thread_updated');
	});

	it('with since: delta fetch plus {latest_id, thread_updated} meta', async () => {
		const rows = [{ id: 6 }, { id: 7 }];
		state.getChatMessagesSince.mockReturnValue({
			messages: rows,
			latest_id: 7,
			thread_updated: '2026-07-04 00:00:00'
		});
		const res = await getChat('?thread=thread-a&since=5');
		expect(res.status).toBe(200);
		expect(state.getChatMessagesSince).toHaveBeenCalledWith(5, 'thread-a', undefined);
		expect(state.getChatMessages).not.toHaveBeenCalled();
		expect(await res.json()).toEqual({
			messages: rows,
			latest_id: 7,
			thread_updated: '2026-07-04 00:00:00'
		});
	});

	it('with since + limit: the explicit limit is passed through to the delta', async () => {
		await getChat('?thread=thread-a&since=5&limit=20');
		expect(state.getChatMessagesSince).toHaveBeenCalledWith(5, 'thread-a', 20);
	});

	it('since=0 is valid (client holds nothing — full thread as a delta)', async () => {
		const res = await getChat('?thread=thread-a&since=0');
		expect(res.status).toBe(200);
		expect(state.getChatMessagesSince).toHaveBeenCalledWith(0, 'thread-a', undefined);
	});

	it('rejects a malformed since with a 400', async () => {
		for (const bad of ['since=abc', 'since=-1', 'since=']) {
			state.getChatMessagesSince.mockClear();
			const res = await getChat(`?thread=thread-a&${bad}`);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'invalid since' });
			expect(state.getChatMessagesSince).not.toHaveBeenCalled();
		}
	});

	it('defaults the thread to "default" on a delta fetch', async () => {
		await getChat('?since=3');
		expect(state.getChatMessagesSince).toHaveBeenCalledWith(3, 'default', undefined);
	});
});
