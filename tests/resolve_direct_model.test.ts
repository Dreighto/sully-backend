import { describe, expect, it, vi, beforeEach } from 'vitest';

const factGateMock = vi.fn(() => ({
	category: 'conversational' as const,
	sensitive: false,
	reason: 'test'
}));

vi.mock('$lib/server/routing/factGate', () => ({
	factGate: (...args: unknown[]) => factGateMock(...args)
}));

vi.mock('$lib/server/model_catalog', () => ({
	resolveChatModel: vi.fn(() => 'deepseek-v4-pro:cloud')
}));

import { resolveDirectModel } from '$lib/server/chat/sdk_direct_reply';
import { resolveChatModel } from '$lib/server/model_catalog';

const baseCtx = {
	allowSensitive: true,
	currentTier: 'chat',
	provider: 'local'
} as Parameters<typeof resolveDirectModel>[0]['ctx'];

describe('resolveDirectModel explicit pick vs fact gate', () => {
	beforeEach(() => {
		factGateMock.mockReset();
		factGateMock.mockReturnValue({
			category: 'world_fact',
			sensitive: true,
			reason: 'world/current fact'
		});
	});

	it('uses fact model when Auto/default (no requestedModel)', () => {
		const picked = resolveDirectModel({ ctx: baseCtx });
		expect(picked.modelId).toBe('gpt-oss:120b-cloud');
		expect(resolveChatModel).not.toHaveBeenCalled();
	});

	it('honors explicit requestedModel even when fact gate would fire', () => {
		const picked = resolveDirectModel({
			ctx: baseCtx,
			requestedModel: 'deepseek-v4-pro:cloud'
		});
		expect(picked.modelId).toBe('deepseek-v4-pro:cloud');
		expect(resolveChatModel).toHaveBeenCalled();
	});
});
