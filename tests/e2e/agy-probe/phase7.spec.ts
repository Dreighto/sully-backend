import { test, expect } from '@playwright/test';

test('visual regression baseline', async ({ page }) => {
	await page.goto('/companion/chat');
	await page.waitForTimeout(1000);
	await expect(page).toHaveScreenshot('chat-empty.png', { maxDiffPixels: 50 });
});
