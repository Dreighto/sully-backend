// PR C: lock the extracted prompt builder. Replaces the source-regex hack from
// PR A — the real `buildSystemPrompt` is now importable + testable.
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
// workspace_context reads SQLite — short-circuit it for these prompt tests.
vi.mock('../src/lib/server/workspace_context', () => ({
	getWorkspaceContext: () => null
}));

beforeEach(() => vi.resetModules());

describe('buildSystemPrompt — companion mode', () => {
	it('uses the companion persona and never mentions LogueOS Console', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const out = buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1'
		});
		expect(out).toMatch(/Captain's local companion/);
		expect(out).not.toMatch(/LogueOS Console/);
		expect(out).not.toMatch(/inside LogueOS/);
		expect(out).not.toMatch(/@cc|@agy/);
		expect(out).toMatch(/Active workspace: companion/);
	});

	it('appends the sensitive-tools clause only when allowSensitive=true', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const off = buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1',
			allowSensitive: false
		});
		const on = buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1',
			allowSensitive: true
		});
		expect(off).not.toMatch(/read_file|web_search/);
		expect(on).toMatch(/read_file/);
		expect(on).toMatch(/web_search/);
		expect(on).toMatch(/UNTRUSTED DATA/);
	});
});

describe('workspace context addendum', () => {
	it('appends operator-authored context when non-null', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		vi.doMock('../src/lib/server/workspace_context', () => ({
			getWorkspaceContext: () => 'remember the secret marker BANANA'
		}));
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const out = buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1'
		});
		expect(out).toMatch(/Workspace-specific context for companion/);
		expect(out).toMatch(/BANANA/);
		vi.doUnmock('../src/lib/server/workspace_context');
	});

	it('omits the addendum section when getWorkspaceContext returns null', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const out = buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1'
		});
		expect(out).not.toMatch(/Workspace-specific context/);
	});

	it('treats allowSensitive=undefined the same as allowSensitive=false', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const omitted = buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1'
		});
		const explicit = buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1',
			allowSensitive: false
		});
		expect(omitted).toBe(explicit);
		expect(omitted).not.toMatch(/read_file|web_search/);
	});
});

describe('buildSystemPrompt — wired (Console) mode', () => {
	it('keeps the legacy Console persona', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'wired';
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const out = buildSystemPrompt({
			targetRepo: 'LogueOS-Console',
			currentTier: 'chat',
			threadId: 't1'
		});
		expect(out).toMatch(/inside LogueOS Console/);
		expect(out).toMatch(/@cc/);
		expect(out).toMatch(/Active workspace: LogueOS-Console/);
		expect(out).toMatch(/Tier: chat/);
	});
});
