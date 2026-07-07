import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { PreparedStreamContext } from '$lib/server/chat/stream_prepare';
import { listAutoModelCandidates, resolveAutoModel } from '$lib/server/chat/auto_router';
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
		shadowDecision: {} as PreparedStreamContext['shadowDecision'],
		...overrides
	};
}

describe('resolveAutoModel', () => {
	beforeEach(() => {
		vi.spyOn(direct, 'isAnthropicCapExceeded').mockReturnValue(false);
		vi.spyOn(cooldown, 'syncAnthropicCapCooldown').mockImplementation(() => {});
		vi.spyOn(cooldown, 'isAutoProviderCooling').mockReturnValue(false);
		vi.spyOn(direct, 'pickModel').mockImplementation((provider, tier, requested) => {
			if (provider === 'anthropic') {
				return { model: {} as never, modelId: 'claude-haiku-4-5-20251001' };
			}
			if (provider === 'google') {
				return { model: {} as never, modelId: 'gemini-2.5-flash-lite' };
			}
			return {
				model: {} as never,
				modelId: requested ?? 'qwen3-coder:480b-cloud'
			};
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('prefers anthropic for chat tier when cap is available', () => {
		const result = resolveAutoModel(baseCtx({ currentTier: 'chat' }));
		expect(result.kind).toBe('direct');
		if (result.kind === 'direct') {
			expect(result.route.provider).toBe('anthropic');
			expect(result.route.reason).toBe('auto_tier_primary');
			expect(result.route.fell_forward).toBe(false);
		}
	});

	it('routes planning tier to CLI when sonnet is resolved', () => {
		vi.spyOn(direct, 'pickModel').mockImplementation((provider, _tier, requested) => {
			if (provider === 'anthropic') {
				return { model: {} as never, modelId: 'claude-sonnet-4-6' };
			}
			if (provider === 'google') {
				return { model: {} as never, modelId: 'gemini-2.5-flash' };
			}
			return { model: {} as never, modelId: requested ?? 'qwen3-coder:480b-cloud' };
		});
		const result = resolveAutoModel(baseCtx({ currentTier: 'planning' }));
		expect(result.kind).toBe('cli');
		if (result.kind === 'cli') {
			expect(result.route.handled_by).toBe('cli');
			expect(result.route.model).toContain('sonnet');
		}
	});

	it('falls forward to google when anthropic cap is exceeded', () => {
		vi.spyOn(direct, 'isAnthropicCapExceeded').mockReturnValue(true);
		const result = resolveAutoModel(baseCtx());
		expect(result.kind).toBe('direct');
		if (result.kind === 'direct') {
			expect(result.route.provider).toBe('google');
			expect(result.route.fell_forward).toBe(true);
		}
	});

	it('falls forward to Ollama Cloud DeepSeek when anthropic and google fail', () => {
		vi.spyOn(direct, 'isAnthropicCapExceeded').mockReturnValue(true);
		vi.spyOn(direct, 'pickModel').mockImplementation((provider, tier, requested) => {
			if (provider === 'google') throw new Error('no google key');
			return {
				model: {} as never,
				modelId: requested ?? 'deepseek-v4-flash:cloud'
			};
		});
		const result = resolveAutoModel(baseCtx({ currentTier: 'chat' }));
		expect(result.kind).toBe('direct');
		if (result.kind === 'direct') {
			expect(result.route.provider).toBe('local');
			expect(result.route.model).toContain('deepseek-v4-flash');
		}
	});

	it('uses DeepSeek Pro for planning tier on Ollama Cloud lane', () => {
		vi.spyOn(direct, 'isAnthropicCapExceeded').mockReturnValue(true);
		vi.spyOn(direct, 'pickModel').mockImplementation((provider, _tier, requested) => {
			if (provider === 'google') throw new Error('no google key');
			return { model: {} as never, modelId: requested ?? 'missing' };
		});
		const result = resolveAutoModel(baseCtx({ currentTier: 'planning' }));
		expect(result.kind).toBe('direct');
		if (result.kind === 'direct') {
			expect(result.route.model).toContain('deepseek-v4-pro');
		}
	});

	it('listAutoModelCandidates returns anthropic then google then ollama', () => {
		const list = listAutoModelCandidates(baseCtx({ currentTier: 'chat' }));
		expect(list.length).toBeGreaterThanOrEqual(2);
		expect(list[0].route.provider).toBe('anthropic');
		expect(list.at(-1)?.route.provider).toBe('local');
	});
});

describe('deterministic thread stickiness (2026-07-07)', () => {
	beforeEach(() => {
		vi.spyOn(direct, 'isAnthropicCapExceeded').mockReturnValue(false);
		vi.spyOn(cooldown, 'syncAnthropicCapCooldown').mockImplementation(() => {});
		vi.spyOn(cooldown, 'isAutoProviderCooling').mockReturnValue(false);
		vi.spyOn(direct, 'pickModel').mockImplementation((provider, _tier, requested) => {
			if (provider === 'anthropic') {
				return { model: {} as never, modelId: 'claude-haiku-4-5-20251001' } as never;
			}
			if (provider === 'google') {
				return { model: {} as never, modelId: 'gemini-2.5-flash-lite' } as never;
			}
			return { model: {} as never, modelId: requested ?? 'deepseek-v4-flash:cloud' } as never;
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stickyCtx(tier: 'chat' | 'planning', prevTier: 'chat' | 'planning', last: string | null) {
		return baseCtx({
			currentTier: tier,
			threadState: {
				current_tier: prevTier,
				last_model_used: last
			} as PreparedStreamContext['threadState']
		});
	}

	it('same-tier turn sticks with the model that last answered, even when anthropic is available', () => {
		const result = resolveAutoModel(stickyCtx('chat', 'chat', 'deepseek-v4-flash:cloud'));
		if (result.kind === 'direct') {
			expect(result.modelHandle.modelId).toBe('deepseek-v4-flash:cloud');
		} else {
			throw new Error('expected direct candidate');
		}
	});

	it('tier escalation re-ranks by provider order (anthropic first) instead of sticking', () => {
		const result = resolveAutoModel(stickyCtx('planning', 'chat', 'deepseek-v4-flash:cloud'));
		if (result.kind === 'cli') {
			expect(result.route.provider).toBe('anthropic');
		} else {
			expect(result.route.provider).toBe('anthropic');
		}
	});

	it('a fresh thread (no last model) takes the ranked head', () => {
		const result = resolveAutoModel(stickyCtx('chat', 'chat', null));
		expect(result.route.provider).toBe('anthropic');
	});

	it('tier de-escalation does NOT unstick — the thread stays on its model', () => {
		const result = resolveAutoModel(stickyCtx('chat', 'planning', 'deepseek-v4-flash:cloud'));
		if (result.kind === 'direct') {
			expect(result.modelHandle.modelId).toBe('deepseek-v4-flash:cloud');
		} else {
			throw new Error('expected direct candidate');
		}
	});
});
