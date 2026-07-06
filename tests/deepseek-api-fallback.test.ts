import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ORIG_KEY = process.env.DEEPSEEK_API_KEY;

describe('deepseek_api — primary/fallback latch', () => {
	beforeEach(async () => {
		process.env.DEEPSEEK_API_KEY = 'sk-test';
		const m = await import('$lib/server/chat/deepseek_api');
		m.resetDeepseekApiLatch();
	});
	afterEach(() => {
		if (ORIG_KEY === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = ORIG_KEY;
	});

	it('serves deepseek-v4 models via the API when key present and healthy', async () => {
		const m = await import('$lib/server/chat/deepseek_api');
		expect(m.isDeepseekApiModel('deepseek-v4-flash:cloud')).toBe(true);
		expect(m.isDeepseekApiModel('deepseek-v4-pro')).toBe(true);
		expect(m.isDeepseekApiModel('gpt-oss:120b-cloud')).toBe(false);
		expect(m.deepseekApiAvailable()).toBe(true);
		expect(m.toDeepseekApiModelId('deepseek-v4-flash:cloud')).toBe('deepseek-v4-flash');
	});

	it('failure opens the fallback latch; success clears it', async () => {
		const m = await import('$lib/server/chat/deepseek_api');
		m.markDeepseekApiFailure('credential_unavailable: no balance');
		expect(m.deepseekApiAvailable()).toBe(false); // -> Ollama fallback
		m.markDeepseekApiSuccess();
		expect(m.deepseekApiAvailable()).toBe(true);
	});

	it('no key -> not available (pure Ollama path)', async () => {
		delete process.env.DEEPSEEK_API_KEY;
		const m = await import('$lib/server/chat/deepseek_api');
		m.resetDeepseekApiLatch();
		expect(m.deepseekApiAvailable()).toBe(false);
	});
});

describe('pricing — deepseek-v4 per-token rates', () => {
	it('prices ds models at API blended rates, other cloud at the indicative rate, local at 0', async () => {
		const { tokenCostUsd } = await import('$lib/server/pricing');
		expect(tokenCostUsd('local', 1_000_000, 'deepseek-v4-flash:cloud')).toBeCloseTo(0.2, 5);
		expect(tokenCostUsd('local', 1_000_000, 'deepseek-v4-pro:cloud')).toBeCloseTo(1.3, 5);
		expect(tokenCostUsd('local', 1_000_000, 'gpt-oss:120b-cloud')).toBeCloseTo(1.5, 5);
		expect(tokenCostUsd('local', 1_000_000, 'qwen2.5:7b')).toBe(0);
	});
});

describe('pickModel — routing decision', () => {
	it('routes ds-v4 to the DeepSeek API when healthy, to Ollama when latched', async () => {
		process.env.DEEPSEEK_API_KEY = 'sk-test';
		const ds = await import('$lib/server/chat/deepseek_api');
		const { pickModel } = await import('$lib/server/chat/sdk_direct_reply');
		ds.resetDeepseekApiLatch();
		const primary = pickModel('local', 'chat', 'deepseek-v4-flash:cloud');
		expect(primary.deepseekApi).toBe(true);
		ds.markDeepseekApiFailure('test');
		const fallback = pickModel('local', 'chat', 'deepseek-v4-flash:cloud');
		expect(fallback.deepseekApi).toBeUndefined(); // ollama path
		ds.resetDeepseekApiLatch();
		const other = pickModel('local', 'chat', 'gpt-oss:120b-cloud');
		expect(other.deepseekApi).toBeUndefined(); // non-ds stays ollama
	});
});
