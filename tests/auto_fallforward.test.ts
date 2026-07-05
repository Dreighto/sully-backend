import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { PreparedStreamContext } from '$lib/server/chat/stream_prepare';
import type { UIMessageChunk } from 'ai';
import * as autoRouter from '$lib/server/chat/auto_router';
import * as direct from '$lib/server/chat/sdk_direct_reply';
import * as cooldown from '$lib/server/chat/auto_provider_cooldown';
import { handleAutoReply } from '$lib/server/chat/sdk_auto_reply';

vi.mock('$lib/server/chat/sdk_stream_common', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/chat/sdk_stream_common')>();
	const chunks: UIMessageChunk[] = [];
	return {
		...actual,
		beginActiveStream: vi.fn(() => ({
			record: (c: UIMessageChunk) => chunks.push(c),
			end: vi.fn(),
			isCurrent: () => true
		})),
		streamResponseFromBuffer: vi.fn(() => new Response('ok')),
		rollbackOrphanTurn: vi.fn(),
		__testChunks: chunks
	};
});

function baseCtx(): PreparedStreamContext {
	return {
		messages: [],
		threadId: 't1',
		taskId: 'sully-test',
		userText: 'hello',
		operatorRowId: 1,
		reused: false,
		currentTier: 'chat',
		threadState: {} as PreparedStreamContext['threadState'],
		targetRepo: 'logueos-sully',
		autoMode: true,
		provider: 'anthropic',
		resolvedModelId: 'claude-haiku-4-5-20251001',
		useClaudeCLI: false,
		allowSensitive: false,
		systemPrompt: 'sys',
		modelMessages: [],
		mutationGate: {} as PreparedStreamContext['mutationGate'],
		shadowDecision: {} as PreparedStreamContext['shadowDecision']
	};
}

describe('handleAutoReply fallforward', () => {
	beforeEach(() => {
		vi.spyOn(cooldown, 'recordAutoProviderFailure').mockImplementation(() => {});
		vi.spyOn(cooldown, 'recordAutoProviderSuccess').mockImplementation(() => {});
		vi.spyOn(autoRouter, 'listAutoModelCandidates').mockReturnValue([
			{
				kind: 'direct',
				modelHandle: { model: {} as never, modelId: 'claude-haiku-4-5-20251001' },
				route: {
					handled_by: 'sdk',
					model: 'claude-haiku-4-5-20251001',
					provider: 'anthropic',
					tier: 'chat',
					reason: 'auto_tier_primary',
					fell_forward: false,
					source: 'auto'
				}
			},
			{
				kind: 'direct',
				modelHandle: { model: {} as never, modelId: 'gemini-2.5-flash-lite' },
				route: {
					handled_by: 'sdk',
					model: 'gemini-2.5-flash-lite',
					provider: 'google',
					tier: 'chat',
					reason: 'auto_tier_fallback',
					fell_forward: true,
					source: 'auto'
				}
			}
		]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('falls forward to the next candidate when the first fails before text', async () => {
		const runDirect = vi
			.spyOn(direct, 'runDirectStreamAttempt')
			.mockResolvedValueOnce({
				ok: false,
				textEmitted: false,
				errorFrame: direct.classifySullyError('Rate limited on haiku', 429)
			})
			.mockResolvedValueOnce({ ok: true, textEmitted: true });

		const request = new Request('http://localhost/api/chat/sdk-stream', { method: 'POST' });
		handleAutoReply(baseCtx(), request);

		await vi.waitFor(() => expect(runDirect).toHaveBeenCalledTimes(2));
		expect(cooldown.recordAutoProviderFailure).toHaveBeenCalledWith(
			'anthropic',
			'rate_limit',
			expect.any(String)
		);
		expect(runDirect.mock.calls[1][0].routing?.reason).toBe('auto_runtime_fallback');
		expect(runDirect.mock.calls[1][0].modelHandle.modelId).toBe('gemini-2.5-flash-lite');
	});
});
