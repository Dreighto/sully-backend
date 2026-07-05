import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { PreparedStreamContext } from '$lib/server/chat/stream_prepare';
import { listAutoModelCandidates } from '$lib/server/chat/auto_router';
import * as direct from '$lib/server/chat/sdk_direct_reply';
import * as cooldown from '$lib/server/chat/auto_provider_cooldown';

function baseCtx(overrides: Partial<PreparedStreamContext> = {}): PreparedStreamContext {
	return {
		messages: [],
		threadId: 't1',
		taskId: 'sully-test',
		userText: 'hello',
		operatorRowId: 1,
		reused: false,
		currentTier: 'chat',
		threadState: {
			thread_id: 't1',
			current_tier: 'chat',
			operator_override: null,
			provider_override: null,
			last_model_used: null,
			updated_at: ''
		},
		targetRepo: 'logueos-sully',
		autoMode: true,
		provider: 'anthropic',
		resolvedModelId: 'claude-haiku-4-5-20251001',
		useClaudeCLI: false,
		allowSensitive: false,
		systemPrompt: 'sys',
		modelMessages: [],
		mutationGate: {} as PreparedStreamContext['mutationGate'],
		shadowDecision: {} as PreparedStreamContext['shadowDecision'],
		...overrides
	};
}

describe('listAutoModelCandidates with provider cooldown', () => {
	beforeEach(() => {
		vi.spyOn(direct, 'isAnthropicCapExceeded').mockReturnValue(false);
		vi.spyOn(cooldown, 'syncAnthropicCapCooldown').mockImplementation(() => {});
		vi.spyOn(direct, 'pickModel').mockImplementation((provider, _tier, requested) => {
			if (provider === 'anthropic') {
				return { model: {} as never, modelId: 'claude-haiku-4-5-20251001' };
			}
			if (provider === 'google') {
				return { model: {} as never, modelId: 'gemini-2.5-flash-lite' };
			}
			return { model: {} as never, modelId: requested ?? 'deepseek-v4-flash:671b-cloud' };
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('omits anthropic while that family is cooling', () => {
		vi.spyOn(cooldown, 'isAutoProviderCooling').mockImplementation(
			(family) => family === 'anthropic'
		);
		const list = listAutoModelCandidates(baseCtx());
		expect(list.every((c) => c.route.provider !== 'anthropic')).toBe(true);
		expect(list[0].route.provider).toBe('google');
	});

	it('prefers last working fallback when anthropic is skipped', () => {
		vi.spyOn(cooldown, 'isAutoProviderCooling').mockImplementation(
			(family) => family === 'anthropic'
		);
		const list = listAutoModelCandidates(
			baseCtx({
				threadState: {
					...baseCtx().threadState,
					last_model_used: 'deepseek-v4-flash:671b-cloud'
				}
			})
		);
		expect(list[0].route.model).toContain('deepseek-v4-flash');
	});
});
