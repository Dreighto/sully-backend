// Lock the shape + auth wiring of Sully's consultation tools. The actual
// upstream calls (Ollama Cloud / Anthropic) are integration-tested live; here
// we pin: (1) the tool exists, (2) it refuses secret-shaped inputs, (3)
// consult_claude picks the right auth header (OAuth-first → API key fallback).
import { describe, expect, it, vi, beforeEach } from 'vitest';

const STUB_ENV: Record<string, string> = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: '/tmp/nonexistent-companion-consult-test.db',
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
	for (const k of ['OLLAMA_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
		delete process.env[k];
	}
	process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
});

describe('deep_think', () => {
	it('refuses questions containing secret-shaped strings (no upstream call)', async () => {
		const everCalled = vi.fn();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				everCalled();
				return new Response('', { status: 200 });
			})
		);
		const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
		const out = (await getSensitiveTools().deep_think.execute!(
			{ question: 'check this sk-abcdef1234567890abcdef please' },
			{} as never
		)) as { error?: string };
		expect(out.error).toMatch(/secret-like/);
		expect(everCalled).not.toHaveBeenCalled();
	});

	it('calls the local Ollama /api/chat with the default cloud model', async () => {
		let body: Record<string, unknown> | null = null;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				body = JSON.parse(String(init?.body));
				return new Response(JSON.stringify({ message: { content: 'a sound answer' } }), {
					status: 200
				});
			})
		);
		const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
		const out = (await getSensitiveTools().deep_think.execute!(
			{ question: 'why does ice float' },
			{} as never
		)) as { answer?: string; model?: string };
		expect(out.answer).toMatch(/sound answer/);
		expect(out.model).toMatch(/cloud$/);
		expect(body!.model).toMatch(/cloud$/);
		expect(body!.stream).toBe(false);
	});
});

describe('consult_claude', () => {
	it('errors clean when neither OAuth nor API key is set', async () => {
		vi.stubGlobal('fetch', vi.fn());
		const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
		const out = (await getSensitiveTools().consult_claude.execute!(
			{ question: 'hi' },
			{} as never
		)) as { error?: string };
		expect(out.error).toMatch(/not configured/);
	});

	it('prefers OAuth (Bearer) when both OAuth token AND API key are present', async () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
		process.env.ANTHROPIC_API_KEY = 'sk-ant-key-test';
		let headers: Record<string, string> = {};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				headers = (init?.headers as Record<string, string>) ?? {};
				return new Response(
					JSON.stringify({ content: [{ type: 'text', text: 'Claude here.' }] }),
					{ status: 200 }
				);
			})
		);
		const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
		const out = (await getSensitiveTools().consult_claude.execute!(
			{ question: 'what is the meaning of x' },
			{} as never
		)) as { answer?: string };
		expect(out.answer).toBe('Claude here.');
		expect(headers.Authorization).toBe('Bearer sk-ant-oat-test');
		expect(headers['x-api-key']).toBeUndefined();
	});

	it('falls back to x-api-key when only ANTHROPIC_API_KEY is set', async () => {
		process.env.ANTHROPIC_API_KEY = 'sk-ant-key-test';
		let headers: Record<string, string> = {};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				headers = (init?.headers as Record<string, string>) ?? {};
				return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
					status: 200
				});
			})
		);
		const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
		await getSensitiveTools().consult_claude.execute!({ question: 'x' }, {} as never);
		expect(headers['x-api-key']).toBe('sk-ant-key-test');
		expect(headers.Authorization).toBeUndefined();
	});

	it('refuses questions containing secret-shaped strings (no upstream call)', async () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
		const everCalled = vi.fn();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				everCalled();
				return new Response('', { status: 200 });
			})
		);
		const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
		const out = (await getSensitiveTools().consult_claude.execute!(
			{ question: 'review my key sk-abcdef1234567890abcdef' },
			{} as never
		)) as { error?: string };
		expect(out.error).toMatch(/secret-like/);
		expect(everCalled).not.toHaveBeenCalled();
	});
});
