// Playwright config — E2E browser tests for the Companion (Sully) PWA.
//
// HERMETIC HARNESS (LOS-182). The suite no longer points at the live :18769
// service: it spawns its OWN production-build server on 127.0.0.1:5188 with a
// FRESH per-run SQLite DB under .e2e-data/ (gitignored). T2's resume-last
// behavior (LOS-178) is correct product behavior, but it makes "a clean
// profile lands on the empty greeting" false the moment any thread persists —
// a reused DB false-failed 4 specs on LOS-181. Fresh DB per run + staged
// scheduling (below) make the suite deterministic. Full contract:
// tests/e2e/README.md.
//
// THREE STAGES PER ENGINE, ordered by project dependencies:
//   1. <engine>            — the empty-state trio (smoke greeting, agy-probe
//                            empty-thread, phase7 chat-empty visual). Read-only
//                            specs that assert the CLEAN-profile rendering, so
//                            they run first, before anything can mutate chat
//                            state. These projects keep the ORIGINAL names
//                            (`chromium` / `iphone-webkit`) because phase7's
//                            committed snapshot baselines and probe.spec's
//                            docs/agy-audit-shots filenames embed the project
//                            name.
//   2. <engine>-rest       — everything else that's read-only w.r.t. chat
//                            state (a11y, eruda, phase6). Defined by EXCLUSION
//                            so a new spec file lands here by default (safe:
//                            after the trio, before the mutator) instead of
//                            silently never running.
//   3. <engine>-mutating   — composer-pulse-timing: the one spec that SENDS a
//                            real chat turn (persists a thread + last_thread).
//                            Runs last and alone — nothing observes "empty"
//                            after it, and the timing it measures isn't skewed
//                            by parallel load.
//
// Run engines via the npm scripts (test:e2e:webkit / test:e2e:chromium /
// test:e2e — sequential engines). Do NOT run bare `playwright test` with no
// --project filter: both engines' stages would interleave in one process and
// engine B's trio can race engine A's mutator. (See README.)
//
// Escape hatch: PLAYWRIGHT_BASE_URL=<origin> skips the managed webServer and
// targets an external server (e.g. the Tailscale hostname for a live
// diagnostic). NON-hermetic — empty-state specs then assume that target has a
// clean profile. Never point this at the live service's DB-backed :18769
// unless that's explicitly the point.
//
// Reminder: Playwright WebKit is desktop WebKit on Linux, not iOS Mobile
// Safari. Catches engine-level issues, NOT iOS-specific quirks (URL-bar
// resize, input-zoom, exact JIT). For those, use Captain's real iPhone
// over Tailscale. WebKit binary: ~/.cache/ms-playwright/webkit-2287.
import { defineConfig, devices } from '@playwright/test';
import { RUN_DB_PATH, RUN_UPLOADS_DIR } from './tests/e2e/harness-paths';

const EXTERNAL_URL = process.env.PLAYWRIGHT_BASE_URL;
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 5188);
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`;

// Stage membership (relative to testDir). The trio + the mutator are pinned
// lists; -rest is "everything except those" so a new spec file can't fall
// through the cracks.
const EMPTY_STATE_TRIO = [
	'**/smoke.spec.ts',
	'**/agy-probe/probe.spec.ts',
	'**/agy-probe/phase7.spec.ts'
];
const MUTATING_SPECS = ['**/composer-pulse-timing.spec.ts'];

const ENGINES = [
	{ name: 'chromium', device: devices['Desktop Chrome'] },
	// iPhone 15 Pro Max device descriptor — closest local approximation of
	// Captain's iPhone 16 Pro Max (DPR=3 + viewport; Playwright has no 16 PM
	// descriptor yet).
	{ name: 'iphone-webkit', device: devices['iPhone 15 Pro Max'] }
];

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 30_000,
	expect: { timeout: 5_000 },
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL: BASE_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure'
	},
	projects: ENGINES.flatMap(({ name, device }) => [
		{
			name,
			use: { ...device },
			testMatch: EMPTY_STATE_TRIO
		},
		{
			name: `${name}-rest`,
			use: { ...device },
			testIgnore: [...EMPTY_STATE_TRIO, ...MUTATING_SPECS],
			dependencies: [name]
		},
		{
			name: `${name}-mutating`,
			use: { ...device },
			testMatch: MUTATING_SPECS,
			dependencies: [`${name}-rest`]
		}
	]),
	// Hermetic server: the adapter-node build with the per-run DB. Shell env
	// beats --env-file (verified Node 22.22.3), so these overrides win over
	// the worktree .env while provider keys/mode still come from it.
	//
	// prep-run-dir.mjs (preconditions + fresh run dir) runs as the first half
	// of THIS command — not in globalSetup — because Playwright starts the
	// webServer BEFORE globalSetup runs (proven 1.60.0, 2026-06-10): a run-dir
	// wipe there deletes the schema the server's bootstrap just created.
	webServer: EXTERNAL_URL
		? undefined
		: {
				command: 'node tests/e2e/prep-run-dir.mjs && node --env-file=.env build/index.js',
				url: `${BASE_URL}/companion/chat`,
				reuseExistingServer: false,
				timeout: 30_000,
				env: {
					PORT: String(PORT),
					HOST: '127.0.0.1',
					LOGUEOS_APP_MODE: 'companion',
					LOGUEOS_MEMORY_DB_PATH: RUN_DB_PATH,
					LOGUEOS_CHAT_UPLOADS_DIR: RUN_UPLOADS_DIR
				}
			}
});
