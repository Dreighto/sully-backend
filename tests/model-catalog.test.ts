// PR D: lock model_catalog resolution rules. Before extraction, model IDs were
// duplicated across llm_router.ts + sdk-stream + voice-reply; these tests pin
// the now-shared resolver so a future "bump Haiku" or "add a new tier" change
// has exactly one place to land.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const STUB_ENV: Record<string, string> = {
	LOGUEOS_APP_MODE: 'companion',
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
};
vi.mock('$env/dynamic/private', () => ({ env: STUB_ENV }));

beforeEach(() => {
	vi.resetModules();
	STUB_ENV.LOGUEOS_APP_MODE = 'companion';
});

describe('model_catalog.resolveChatModel', () => {
	it('honors an explicit requestedModel over everything else', async () => {
		const { resolveChatModel } = await import('../src/lib/server/model_catalog');
		expect(
			resolveChatModel({
				tier: 'chat',
				provider: 'local',
				requestedModel: 'gpt-oss:120b-cloud'
			})
		).toBe('gpt-oss:120b-cloud');
	});

	it('companion mode + local provider with NO requestedModel uses COMPANION_DEFAULT_MODEL', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { resolveChatModel } = await import('../src/lib/server/model_catalog');
		expect(resolveChatModel({ tier: 'chat', provider: 'local' })).toBe('companion-v1:latest');
	});

	it('wired mode + local provider falls through the tier matrix (no companion override)', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'wired';
		const { resolveChatModel } = await import('../src/lib/server/model_catalog');
		expect(resolveChatModel({ tier: 'chat', provider: 'local' })).toBe('qwen3:14b');
	});

	it('returns the canonical id per tier × provider', async () => {
		const { resolveChatModel } = await import('../src/lib/server/model_catalog');
		expect(resolveChatModel({ tier: 'chat', provider: 'anthropic' })).toBe(
			'claude-haiku-4-5-20251001'
		);
		expect(resolveChatModel({ tier: 'planning', provider: 'google' })).toBe('gemini-2.5-flash');
		expect(resolveChatModel({ tier: 'deep', provider: 'anthropic' })).toBe('claude-opus-4-8');
	});

	it('throws when an unknown tier × provider pair is requested (no silent fallback)', async () => {
		const { resolveChatModel } = await import('../src/lib/server/model_catalog');
		// 'local' tier only registers the local provider — asking for openai must fail loud.
		expect(() => resolveChatModel({ tier: 'local', provider: 'openai' })).toThrow(
			/no model registered/
		);
	});
});

describe('model_catalog.resolveVoiceModel', () => {
	it('defaults to companion-v1-voice:latest', async () => {
		delete STUB_ENV.COMPANION_VOICE_MODEL;
		const { resolveVoiceModel } = await import('../src/lib/server/model_catalog');
		expect(resolveVoiceModel()).toBe('companion-v1-voice:latest');
	});

	it('honors COMPANION_VOICE_MODEL override', async () => {
		const prev = process.env.COMPANION_VOICE_MODEL;
		process.env.COMPANION_VOICE_MODEL = 'my-tuned:latest';
		const { resolveVoiceModel } = await import('../src/lib/server/model_catalog');
		expect(resolveVoiceModel()).toBe('my-tuned:latest');
		if (prev === undefined) delete process.env.COMPANION_VOICE_MODEL;
		else process.env.COMPANION_VOICE_MODEL = prev;
	});
});
