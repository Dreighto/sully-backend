// Axe-core accessibility scan across the chat surface states Lighthouse
// can't reach in a single audit. Lighthouse only saw the empty-state
// chat in the AGY audit, which is why we caught the Regen / Play
// label-content-name-mismatch by hand. This suite exercises:
//
//   1. Empty chat — baseline (matches Lighthouse's view)
//   2. Chat with messages — exposes Copy/Regen/Play/👍/👎 + bubbles
//   3. Model picker open — exposes the dropdown menu items
//
// Runs on both chromium and iphone-webkit (44 px tap-target rules and
// some color-contrast tests behave differently per viewport).
//
// Critical / serious violations fail the test. Moderate / minor are
// logged for review but don't gate the run — they capture future polish.
import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

type Severity = 'minor' | 'moderate' | 'serious' | 'critical';
const BLOCKING: Severity[] = ['serious', 'critical'];
const ALL: Severity[] = ['minor', 'moderate', 'serious', 'critical'];

function severityCount(violations: Array<{ impact?: string | null }>) {
	const out: Record<string, number> = { minor: 0, moderate: 0, serious: 0, critical: 0 };
	for (const v of violations) {
		const k = (v.impact || 'minor') as string;
		if (k in out) out[k]++;
	}
	return out;
}

async function runAxe(page: import('@playwright/test').Page, surfaceLabel: string) {
	const results = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
		.analyze();

	const counts = severityCount(results.violations);
	const blocking = results.violations.filter((v) =>
		BLOCKING.includes((v.impact || 'minor') as Severity)
	);

	// Console summary for the test log — visible in CI output.
	console.log(`\n[a11y ${surfaceLabel}] ${ALL.map((s) => `${s}=${counts[s]}`).join('  ')}`);
	for (const v of results.violations) {
		const nodes = v.nodes.length;
		console.log(
			`  ${v.impact || 'minor'.padEnd(8)}  ${v.id}  (${nodes} node${nodes === 1 ? '' : 's'})  — ${v.help}`
		);
	}

	return { results, counts, blocking };
}

test.describe('axe a11y scan', () => {
	test('empty chat — no serious/critical violations', async ({ page }) => {
		await page.goto('/companion/chat');
		await page.waitForLoadState('networkidle');
		const { blocking } = await runAxe(page, 'empty-chat');
		expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
	});

	test('chat with messages — exposes reply footer buttons', async ({ page }) => {
		await page.goto('/companion/chat?thread=chat-n72y4df0');
		await page.waitForLoadState('networkidle');
		// give Markdown bubbles + footer buttons time to render
		await page.waitForTimeout(800);
		const { blocking } = await runAxe(page, 'with-messages');
		expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
	});

	test('model picker open — exposes dropdown menu items', async ({ page }) => {
		await page.goto('/companion/chat');
		await page.waitForLoadState('networkidle');
		const picker = page.locator('header [data-popover-trigger]');
		if ((await picker.count()) > 0) {
			await picker.first().click();
			await page.waitForTimeout(400);
		}
		const { blocking } = await runAxe(page, 'model-picker-open');
		expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
	});
});
