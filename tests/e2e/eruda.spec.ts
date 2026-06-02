// Eruda activation contract:
//   - off by default (no ?debug=1, no localStorage flag) -> window.eruda undefined
//   - ?debug=1 turns it on AND persists via localStorage
//   - ?debug=0 clears the persistence
//
// Runs on both chromium and iphone-webkit projects — the loader is plain
// inline JS, so the same behavior must hold in both engines.
import { test, expect } from '@playwright/test';

test('eruda stays dormant when debug flag is absent', async ({ page }) => {
	await page.goto('/companion/chat');
	const present = await page.evaluate(
		() => typeof (window as unknown as { eruda?: unknown }).eruda
	);
	expect(present).toBe('undefined');
});

test('?debug=1 activates eruda and persists via localStorage', async ({ page }) => {
	await page.goto('/companion/chat?debug=1');
	// Wait up to 5s for the CDN load + eruda.init() to settle.
	await page.waitForFunction(
		() => typeof (window as unknown as { eruda?: unknown }).eruda !== 'undefined',
		undefined,
		{ timeout: 5_000 }
	);
	const persisted = await page.evaluate(() => localStorage.getItem('eruda'));
	expect(persisted).toBe('1');
});

test('?debug=0 clears the persistence', async ({ page }) => {
	await page.goto('/companion/chat?debug=1');
	await page.waitForFunction(
		() => typeof (window as unknown as { eruda?: unknown }).eruda !== 'undefined'
	);
	await page.goto('/companion/chat?debug=0');
	const persisted = await page.evaluate(() => localStorage.getItem('eruda'));
	expect(persisted).toBeNull();
});
