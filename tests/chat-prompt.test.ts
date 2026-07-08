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
	it('introduces the model as Sully and never mentions LogueOS Console', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const out = await buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1'
		});
		// Sully persona — companion-first identity
		expect(out).toMatch(/You are Sully/);
		expect(out).toMatch(/just talk to/);
		// The two-textures mechanic (talk vs work) is the core of her
		expect(out).toMatch(/two textures/);
		// Warm, present companion vibe
		expect(out).toMatch(/genuinely present/);
		// Honest, not a yes-man
		expect(out).toMatch(/honest/);
		// Console-mode artifacts must NOT appear here
		expect(out).not.toMatch(/LogueOS Console/);
		expect(out).not.toMatch(/inside LogueOS/);
		// She's the hub — hands work to CC/AGY (she does NOT do it herself)
		expect(out).toMatch(/hand it off/);
		expect(out).toMatch(/@cc/);
		// Roster-aware: knows the full team + routes to the right worker (SUL: CLI-driver).
		expect(out).toMatch(/DPSK/);
		expect(out).toMatch(/Cursor/);
		expect(out).toMatch(/Active workspace: companion/);
	});

	it('carries the anti-confabulation guardrail (no claiming work she did not dispatch)', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const out = await buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1'
		});
		expect(out).toMatch(/do NOT do yourself is the heavy WORK/);
		expect(out).toMatch(/unless a worker was ACTUALLY dispatched/);
		expect(out).toMatch(/invent progress/);
	});

	it('voice prompt also carries the anti-confabulation guardrail', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { buildVoiceSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const out = await buildVoiceSystemPrompt('t1');
		// Anti-confabulation guardrail: reworded 2026-07-06 when web tools were
		// wired into voice. Substance unchanged — she still can't lie about doing
		// heavy work she didn't do, and she still can't say "on it" without a
		// real dispatch. Only the surface wording moved.
		expect(out).toMatch(/do NOT do HEAVY work yourself/);
		expect(out).toMatch(/NEVER say you're "on it"/);
		expect(out).toMatch(/You are Sully/);
		// Sully now self-serves light tasks (speed test) rather than dispatching.
		expect(out).toMatch(/run_speed_test/);
	});

	it('appends the sensitive-tools clause only when allowSensitive=true', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const off = await buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1',
			allowSensitive: false
		});
		const on = await buildSystemPrompt({
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
		const out = await buildSystemPrompt({
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
		const out = await buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1'
		});
		expect(out).not.toMatch(/Workspace-specific context/);
	});

	it('treats allowSensitive=undefined the same as allowSensitive=false', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const omitted = await buildSystemPrompt({
			targetRepo: 'companion',
			currentTier: 'chat',
			threadId: 't1'
		});
		const explicit = await buildSystemPrompt({
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
		const out = await buildSystemPrompt({
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

describe('buildSystemPrompt — fact-check grounding discipline', () => {
	const FACT_Q = 'what is the current price of bitcoin right now?';

	it('with web tools: forces a real search + bans memory/invented URLs', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const out = await buildSystemPrompt(
			{ targetRepo: 'companion', currentTier: 'chat', threadId: 't1', allowSensitive: true },
			FACT_Q
		);
		expect(out).toMatch(/FACT CHECK/);
		expect(out).toMatch(/MUST call web_search/);
		expect(out).toMatch(/NEVER write a URL from memory or invent one/i);
	});

	it('without web tools: tells the model to say it cannot verify (no fabrication)', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const { buildSystemPrompt } = await import('../src/lib/server/chat_prompt');
		const out = await buildSystemPrompt(
			{ targetRepo: 'companion', currentTier: 'chat', threadId: 't1', allowSensitive: false },
			FACT_Q
		);
		expect(out).toMatch(/NO web access/);
		expect(out).toMatch(/can't verify that right now/i);
		// must NOT tell a tool-less model to "call web_search"
		expect(out).not.toMatch(/MUST call web_search/);
	});
});
