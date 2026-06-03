// Lock the web_search dual-source fall-forward (PR: Perplexity primary,
// Firecrawl fallback). When Perplexity responds with 401 (quota exhausted),
// 429 (rate-limited), or 5xx, the tool MUST silently fall forward to Firecrawl
// — the operator should never see "insufficient_quota" leak through to the UI
// just because Perplexity ran out.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const STUB_ENV: Record<string, string> = {
	LOGUEOS_APP_MODE: 'companion',
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000',
	PERPLEXITY_API_KEY: 'pplx-test-key',
	FIRECRAWL_API_KEY: 'fc-test-key'
};
vi.mock('$env/dynamic/private', () => ({ env: STUB_ENV }));

beforeEach(() => {
	vi.resetModules();
	process.env.PERPLEXITY_API_KEY = 'pplx-test-key';
	process.env.FIRECRAWL_API_KEY = 'fc-test-key';
	// The legacy fall-forward suite tests the Perplexity→Firecrawl chain. Ollama
	// is the new primary; unset its key here so these cases exercise the chain
	// they were written for. The Ollama-primary case sets it explicitly.
	delete process.env.OLLAMA_API_KEY;
});

// Build a fetch stub that branches on URL.
function makeFetchStub(handlers: Record<string, () => Response | Promise<Response>>) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();
		for (const [match, handler] of Object.entries(handlers)) {
			if (url.includes(match)) return handler();
		}
		return new Response('unmatched url', { status: 404 });
	});
}

describe('web_search dual-source', () => {
	it('uses Perplexity when it succeeds and never calls Firecrawl', async () => {
		const fc = vi.fn();
		vi.stubGlobal(
			'fetch',
			makeFetchStub({
				'api.perplexity.ai': () =>
					new Response(
						JSON.stringify({
							choices: [{ message: { content: 'Sam Altman is CEO of OpenAI.' } }],
							citations: ['https://openai.com/about']
						}),
						{ status: 200 }
					),
				'api.firecrawl.dev': () => {
					fc();
					return new Response('should not be called', { status: 500 });
				}
			})
		);
		const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
		const tools = getSensitiveTools();
		const exec = tools.web_search.execute!;
		const out = (await exec({ query: 'who is OpenAI CEO', limit: 5 }, {} as never)) as {
			provider?: string;
			answer?: string;
		};
		expect(out.provider).toBe('perplexity');
		expect(out.answer).toMatch(/Sam Altman/);
		expect(fc).not.toHaveBeenCalled();
	});

	it('falls forward to Firecrawl on Perplexity 401 (quota exhausted)', async () => {
		vi.stubGlobal(
			'fetch',
			makeFetchStub({
				'api.perplexity.ai': () =>
					new Response(JSON.stringify({ error: { message: 'insufficient_quota', code: 401 } }), {
						status: 401
					}),
				'api.firecrawl.dev': () =>
					new Response(
						JSON.stringify({
							data: { web: [{ title: 'Wiki', url: 'https://w', description: 'snip' }] }
						}),
						{ status: 200 }
					)
			})
		);
		const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
		const tools = getSensitiveTools();
		const exec = tools.web_search.execute!;
		const out = (await exec({ query: 'X', limit: 5 }, {} as never)) as {
			provider?: string;
			results?: unknown[];
			priorFailures?: string[];
		};
		expect(out.provider).toBe('firecrawl');
		expect(out.results?.length).toBe(1);
		expect((out.priorFailures ?? []).join(' ')).toMatch(/401/);
	});

	it('falls forward on Perplexity 429 (rate limit) and 503 (server error)', async () => {
		for (const status of [429, 503]) {
			vi.stubGlobal(
				'fetch',
				makeFetchStub({
					'api.perplexity.ai': () => new Response('err', { status }),
					'api.firecrawl.dev': () =>
						new Response(
							JSON.stringify({
								data: { web: [{ title: 'T', url: 'https://u', description: 's' }] }
							}),
							{ status: 200 }
						)
				})
			);
			const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
			const exec = getSensitiveTools().web_search.execute!;
			const out = (await exec({ query: 'q', limit: 5 }, {} as never)) as { provider?: string };
			expect(out.provider, `${status} should fall forward`).toBe('firecrawl');
			vi.resetModules();
		}
	});

	it('returns a useful error when BOTH providers fail', async () => {
		vi.stubGlobal(
			'fetch',
			makeFetchStub({
				'api.perplexity.ai': () => new Response('quota', { status: 401 }),
				'api.firecrawl.dev': () => new Response('down', { status: 503 })
			})
		);
		const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
		const tools = getSensitiveTools();
		const exec = tools.web_search.execute!;
		const out = (await exec({ query: 'x', limit: 5 }, {} as never)) as { error?: string };
		expect(out.error).toMatch(/web search failed/);
		expect(out.error).toMatch(/perplexity.*401/);
		expect(out.error).toMatch(/firecrawl.*503/);
	});

	it('uses Ollama Pro as the primary provider when its key is set', async () => {
		process.env.OLLAMA_API_KEY = 'ollama-test-key';
		const pplx = vi.fn();
		vi.stubGlobal(
			'fetch',
			makeFetchStub({
				'ollama.com/api/web_search': () =>
					new Response(
						JSON.stringify({
							results: [
								{ title: 'Ollama Docs', url: 'https://ollama.com', content: 'full page text' }
							]
						}),
						{ status: 200 }
					),
				'api.perplexity.ai': () => {
					pplx();
					return new Response('should not be called', { status: 500 });
				}
			})
		);
		const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
		const exec = getSensitiveTools().web_search.execute!;
		const out = (await exec({ query: 'ollama web search', limit: 3 }, {} as never)) as {
			provider?: string;
			results?: { snippet?: string }[];
		};
		expect(out.provider).toBe('ollama');
		expect(out.results?.[0].snippet).toMatch(/full page text/);
		expect(pplx).not.toHaveBeenCalled();
	});

	it('refuses queries containing secret-shaped strings (no provider call)', async () => {
		const everCalled = vi.fn();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				everCalled();
				return new Response('', { status: 200 });
			})
		);
		const { getSensitiveTools } = await import('../src/lib/server/companion_tools');
		const tools = getSensitiveTools();
		const exec = tools.web_search.execute!;
		const out = (await exec(
			{ query: 'check this sk-abcdef1234567890abcdef', limit: 5 },
			{} as never
		)) as { error?: string };
		expect(out.error).toMatch(/secret-like/);
		expect(everCalled).not.toHaveBeenCalled();
	});
});
