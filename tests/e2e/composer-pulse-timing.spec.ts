// Empirical timing of the composer's `composer-sending` class lifecycle.
// Operator reported the pulse persisting after replies — this test gives
// us hard numbers vs theorizing.
import { test, expect } from '@playwright/test';

test('composer pulse clears within 1.5s of last token', async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto('/companion/chat');
	await expect(page.getByText("Hey Captain — what's on your mind?", { exact: false })).toBeVisible({
		timeout: 10_000
	});

	const textarea = page.locator('textarea').first();
	await textarea.click();
	await textarea.fill('Hey, quick one — say hi back.');

	// Send button only renders after textDraft becomes non-empty (Svelte's
	// {#if textDraft.trim() ...} in Composer). Wait for it explicitly.
	const sendBtn = page.getByRole('button', { name: 'Send Message' });
	await expect(sendBtn).toBeVisible({ timeout: 5_000 });

	// Composer pill (the outer div that gets composer-sending when sending).
	// Selected by test id, NOT by utility class — the D2 token sweep (LOS-185)
	// broke the old `div.rounded-3xl` selector when radii moved to var() tokens.
	const composerPill = page.getByTestId('composer-pill');

	const tSendClick = Date.now();
	await sendBtn.click();

	// Wait until composer-sending class is APPLIED to the composer pill.
	await expect
		.poll(() => composerPill.evaluate((el) => el.classList.contains('composer-sending')), {
			timeout: 5_000,
			intervals: [50, 100]
		})
		.toBe(true);
	const tPulseStart = Date.now();

	// First assistant Markdown paragraph appears in the feed.
	const firstReply = page.locator('main >> div.md-content >> p').first();
	await firstReply.waitFor({ state: 'visible', timeout: 30_000 });
	const tFirstToken = Date.now();

	// Wait until reply text stops growing — proxy for "last token rendered."
	let prev = '';
	let stable = 0;
	while (stable < 3) {
		const cur = (await firstReply.textContent()) ?? '';
		if (cur === prev && cur.length > 0) stable++;
		else stable = 0;
		prev = cur;
		await page.waitForTimeout(150);
	}
	const tLastToken = Date.now();

	// Now wait for composer-sending class to be REMOVED.
	await expect
		.poll(() => composerPill.evaluate((el) => el.classList.contains('composer-sending')), {
			timeout: 10_000,
			intervals: [50, 100, 200]
		})
		.toBe(false);
	const tPulseEnd = Date.now();

	const pulseAfterLastToken = tPulseEnd - tLastToken;
	const replyLen = ((await firstReply.textContent()) ?? '').length;

	console.log(
		`[pulse-timing] click→pulse-start=${tPulseStart - tSendClick}ms, ` +
			`pulse-start→first-token=${tFirstToken - tPulseStart}ms, ` +
			`first-token→last-token=${tLastToken - tFirstToken}ms, ` +
			`last-token→pulse-end=${pulseAfterLastToken}ms, ` +
			`reply=${replyLen}chars`
	);

	expect(pulseAfterLastToken, 'composer pulse must clear within 1.5s of last token').toBeLessThan(
		1500
	);
});
