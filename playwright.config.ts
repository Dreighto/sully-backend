// Playwright config — E2E browser tests for the Companion (Sully) PWA.
//
// Two projects:
//   chromium        — Desktop Chrome viewport. Fast, what we've been using
//                     via the Playwright MCP all along.
//   iphone-webkit   — iPhone 15 Pro Max device descriptor on the WebKit
//                     engine. The closest local approximation of Captain's
//                     iPhone 16 Pro Max (Playwright doesn't yet ship a 16
//                     PM descriptor; the 15 PM matches DPR=3 + viewport).
//                     WebKit binary lives at ~/.cache/ms-playwright/webkit-2287
//                     (installed 2026-06-01 alongside this config).
//
// Companion runs under systemd at :18769 in production-build mode, so we
// rely on the live service rather than spawning `vite dev`. Override via
// PLAYWRIGHT_BASE_URL if pointing at a different host (e.g. the Tailscale
// hostname).
//
// Reminder: Playwright WebKit is desktop WebKit on Linux, not iOS Mobile
// Safari. Catches engine-level issues, NOT iOS-specific quirks (URL-bar
// resize, input-zoom, exact JIT). For those, use Captain's real iPhone
// over Tailscale.
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:18769';

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
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		},
		{
			name: 'iphone-webkit',
			use: { ...devices['iPhone 15 Pro Max'] }
		}
	]
});
