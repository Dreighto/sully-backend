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
