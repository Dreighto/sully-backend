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

// Source-level regression guard: the companion-mode prompt branch must never
// re-introduce "LogueOS Console". Runtime-import test of the prompt builder
// itself is deferred to PR C (when chat_prompt.ts extracts it from the routes —
// route files pull in $types/$app and don't import cleanly from a vitest node
// env). For now we lock the SOURCE of the route's companion branch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('companion prompt regression guard (source-level)', () => {
	const PROMPT_ROUTES = [
		'src/routes/api/chat/sdk-stream/+server.ts',
		'src/routes/api/chat/+server.ts'
	];

	for (const rel of PROMPT_ROUTES) {
		it(`${rel}: companion branch does not mention 'LogueOS Console'`, () => {
			const src = readFileSync(join(process.cwd(), rel), 'utf-8');
			// Extract the companion-mode prompt branch — text between
			// `runMode.companion` and the `: \`` that opens the wired branch.
			const m = src.match(/runMode\.companion[\s\S]*?\?\s*`([\s\S]*?)`\s*:\s*`/);
			expect(m, 'expected runMode.companion ? `…` : `…` shape').toBeTruthy();
			const companionPrompt = m![1];
			expect(companionPrompt).not.toMatch(/LogueOS Console/);
			expect(companionPrompt).not.toMatch(/inside LogueOS/);
			expect(companionPrompt).not.toMatch(/@cc|@agy/);
		});
	}

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
