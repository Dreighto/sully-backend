import { test, expect } from '@playwright/test';
import fs from 'fs';

test('Phase 6 iPhone WebKit probe', async ({ page }, testInfo) => {
	await page.goto('/companion/chat');
	await page.waitForTimeout(1000);

	const viewportBefore = await page.evaluate(() => ({
		w: window.innerWidth,
		h: window.innerHeight
	}));

	// Focus composer to see if viewport reflows
	const textarea = page.locator('textarea');
	if ((await textarea.count()) > 0) {
		await textarea.first().focus();
		await page.waitForTimeout(500);
	}
	const viewportAfter = await page.evaluate(() => ({
		w: window.innerWidth,
		h: window.innerHeight
	}));

	// Read safe-area insets
	const safeAreas = await page.evaluate(() => {
		const div = document.createElement('div');
		div.style.paddingTop = 'env(safe-area-inset-top)';
		div.style.paddingBottom = 'env(safe-area-inset-bottom)';
		document.body.appendChild(div);
		const style = getComputedStyle(div);
		const top = style.paddingTop;
		const bottom = style.paddingBottom;
		document.body.removeChild(div);
		return { top, bottom };
	});

	// Tap target sizes < 44x44
	const smallTargets = await page.evaluate(() => {
		const els = Array.from(
			document.querySelectorAll('button, a, input, select, textarea, [role="button"]')
		);
		return els
			.map((e) => {
				const rect = e.getBoundingClientRect();
				return {
					tag: e.tagName,
					className: e.className,
					w: rect.width,
					h: rect.height
				};
			})
			.filter((e) => e.w > 0 && e.h > 0 && (e.w < 44 || e.h < 44));
	});

	const results = {
		viewportBefore,
		viewportAfter,
		safeAreas,
		smallTargets
	};

	fs.writeFileSync('docs/phase6_results.json', JSON.stringify(results, null, 2));
});
