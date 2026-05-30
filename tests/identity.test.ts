// Lock the PR A identity fix from regressing: the companion model must never
// be told it is the Console in its own system prompt, and the default workspace
// must come from appIdentity (not hard-coded 'LogueOS-Console').
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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

beforeEach(() => vi.resetModules());
afterEach(() => {
	STUB_ENV.LOGUEOS_APP_MODE = 'companion';
});

describe('appIdentity (PR A)', () => {
	it('companion mode resolves to the companion identity', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const mod = await import('../src/lib/server/config');
		expect(mod.appIdentity.appName).toBe('LogueOS Companion');
		expect(mod.appIdentity.defaultWorkspace).toBe('companion');
		expect(mod.appIdentity.basePath).toBe('/companion');
		expect(mod.appIdentity.pushDefaultUrl).toBe('/companion/chat');
		// The model itself is named Sully (operator's chosen persona name).
		expect(mod.appIdentity.personaName).toBe('Sully');
		expect(mod.appIdentity.coreLabel).toBe('Sully');
	});

	it('wired mode keeps the legacy Console identity', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'wired';
		const mod = await import('../src/lib/server/config');
		expect(mod.appIdentity.appName).toBe('LogueOS Console');
		expect(mod.appIdentity.defaultWorkspace).toBe('LogueOS-Console');
		expect(mod.appIdentity.basePath).toBe('/console');
	});

	it('clientSafeConfig leaks ONLY label fields, never filesystem paths', async () => {
		STUB_ENV.LOGUEOS_APP_MODE = 'companion';
		const mod = await import('../src/lib/server/config');
		const exposed = mod.clientSafeConfig.appIdentity;
		expect(Object.keys(exposed).sort()).toEqual(
			['appName', 'coreLabel', 'defaultWorkspace'].sort()
		);
		expect(JSON.stringify(exposed)).not.toMatch(/dreighto|home|\.env|secret/i);
	});
});

// PR C extracted buildSystemPrompt → $lib/server/chat_prompt.ts; it's now
// tested directly in tests/chat-prompt.test.ts (runtime, not source-regex).
// Only the page.svelte hard-code guard remains here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('client-side identity guard', () => {

	it('no client-fork-sensitive code hard-codes "LogueOS-Console" outside FALLBACK', () => {
		// page.svelte default workspace was the original regression spot.
		const page = readFileSync(
			join(process.cwd(), 'src/routes/chat/+page.svelte'),
			'utf-8'
		);
		// Find the `let selectedRepo = $state…` initializer block. Allow nested
		// parens because the call sometimes wraps in untrack(() => …).
		const initLine = page.match(/let selectedRepo[\s\S]{0,400}?;/)?.[0] ?? '';
		expect(initLine).not.toMatch(/= \$state\(\s*['"]LogueOS-Console['"]/);
		expect(initLine).toMatch(/appIdentity/);
	});
});
