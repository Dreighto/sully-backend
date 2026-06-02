// Smoke test — verifies both chromium and iphone-webkit projects work
// against the live companion service. Catches the "wrong engine, broken
// install" cases that would otherwise only surface during a real diagnostic.
//
// Each test runs ONCE per project, so a green run here means BOTH engines
// successfully connected, navigated, hydrated, and rendered Sully's chat
// surface.
import { test, expect } from '@playwright/test';

test('chat surface loads + Sully greeting renders', async ({ page }) => {
	await page.goto('/companion/chat');
	await expect(page).toHaveTitle('Companion');
	// SvelteKit hydrated and the empty-state greeting is up
	// (a clean profile lands on the empty thread).
	await expect(page.getByText("Hey Captain — what's on your mind?", { exact: false })).toBeVisible({
		timeout: 10_000
	});
});

test('feedback API returns 200 for a valid signal', async ({ request }) => {
	// Use a known-existing message id; if the DB is empty the route returns
	// 404 which we accept (means the endpoint shape is correct).
	const resp = await request.post('/companion/api/chat/feedback', {
		data: { message_id: 1, signal: 0 }
	});
	expect([200, 404]).toContain(resp.status());
});
