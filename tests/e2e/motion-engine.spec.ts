/**
 * Motion engine verification — instrumented transform sampling.
 * Proves spring-driven sheets continue from finger position (no snap-to-0)
 * and stay mounted until spring rest.
 */
import { test, expect, type Page } from '@playwright/test';

const CHAT_PATH = '/companion/chat';

function parseTranslateX(transform: string): number {
	if (transform === 'none') return 0;
	const m = transform.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([^,]+),/);
	return m ? parseFloat(m[1]) : 0;
}

function parseTranslateY(transform: string): number {
	if (transform === 'none') return 0;
	const m = transform.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^)]+)\)/);
	return m ? parseFloat(m[1]) : 0;
}

async function readSheetTranslateY(page: Page): Promise<number> {
	return page.evaluate(() => {
		const el = document.querySelector('[data-testid="model-picker-sheet"]') as HTMLElement | null;
		if (!el) return 999;
		return parseTranslateY(getComputedStyle(el).transform);

		function parseTranslateY(transform: string): number {
			if (transform === 'none') return 0;
			const m = transform.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^)]+)\)/);
			return m ? parseFloat(m[1]) : 0;
		}
	});
}

async function setupMobileChat(page: Page) {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.addInitScript(() => {
		// Belt-and-suspenders: unregister any SW left from a prior run on the same origin.
		void navigator.serviceWorker?.getRegistrations().then((regs) => {
			for (const reg of regs) void reg.unregister();
		});
	});
	await page.goto(CHAT_PATH, { waitUntil: 'domcontentloaded' });
	await page.waitForURL(`**${CHAT_PATH}**`, { timeout: 10_000 });
	await expect(page.getByTestId('model-picker-chip')).toBeVisible({ timeout: 10_000 });
	await ensureSidebarClosed(page);
}

async function waitForChatSurface(page: Page) {
	await page.addInitScript(() => {
		void navigator.serviceWorker?.getRegistrations().then((regs) => {
			for (const reg of regs) void reg.unregister();
		});
	});
	await page.goto(CHAT_PATH, { waitUntil: 'domcontentloaded' });
	await page.waitForURL(`**${CHAT_PATH}**`, { timeout: 10_000 });
	await expect(
		page.getByText("Hey Captain — what's on your mind?", { exact: false })
	).toBeVisible({ timeout: 10_000 });
}

async function ensureSidebarClosed(page: Page) {
	const scrim = page.getByTestId('threads-sidebar-scrim');
	if (await scrim.isVisible().catch(() => false)) {
		await scrim.click({ force: true });
		await expect(scrim).toBeHidden({ timeout: 3000 });
	}
}

/** Open picker and wait for mount + near-settled open spring. */
async function openModelPickerInPage(page: Page) {
	await page.waitForFunction(() => window.innerWidth > 0 && window.innerWidth < 1024);
	await page.evaluate(() => {
		const chip = document.querySelector('header [data-popover-trigger]') as HTMLButtonElement | null;
		chip?.click();
	});
	await expect.poll(() => readSheetTranslateY(page), { timeout: 8000 }).toBeLessThan(30);
	await expect(page.getByTestId('model-picker-sheet-handle')).toBeVisible({ timeout: 3000 });
}

/** Drag the sheet handle with real pointer events (Svelte handlers need trusted input). */
async function dragSheetHandle(page: Page, deltaY: number): Promise<number> {
	const handle = page.getByTestId('model-picker-sheet-handle');
	await expect(handle).toBeVisible();
	const box = await handle.boundingBox();
	if (!box) throw new Error('model picker handle has no bounding box');

	const cx = box.x + box.width / 2;
	const cy = box.y + Math.min(12, box.height / 2);

	await page.mouse.move(cx, cy);
	await page.mouse.down();
	for (let i = 1; i <= 12; i++) {
		const y = cy + (deltaY * i) / 12;
		await page.mouse.move(cx, y, { steps: 2 });
	}
	const midY = await readSheetTranslateY(page);
	await page.mouse.move(cx, cy + deltaY);
	await page.mouse.up();
	return midY;
}

test.describe.configure({ mode: 'serial' });

test.describe('spring motion engine', () => {
	test('model picker tracks finger during drag and does not snap to 0 on release', async ({
		page
	}) => {
		test.setTimeout(60_000);

		await setupMobileChat(page);
		const urlBefore = page.url();

		let navigatedAway = false;
		page.on('framenavigated', (frame) => {
			if (frame !== page.mainFrame()) return;
			if (!frame.url().includes(CHAT_PATH)) navigatedAway = true;
		});

		await openModelPickerInPage(page);
		const yBefore = await readSheetTranslateY(page);

		const midY = await dragSheetHandle(page, 100);
		expect(navigatedAway).toBe(false);
		expect(page.url()).toBe(urlBefore);

		await page.waitForTimeout(48);

		const afterReleaseY = await readSheetTranslateY(page);
		const mountedAfterRelease = await page.evaluate(
			() => !!document.querySelector('[data-testid="model-picker-sheet"]')
		);

		expect(navigatedAway).toBe(false);
		expect(page.url()).toBe(urlBefore);

		expect(midY).toBeGreaterThan(yBefore + 15);
		expect(midY).toBeGreaterThan(35);
		expect(afterReleaseY).toBeGreaterThan(15);
		expect(afterReleaseY).toBeLessThanOrEqual(midY + 2);
		expect(mountedAfterRelease).toBe(true);
	});

	test('model picker tap-away animates closed without instant unmount', async ({ page }) => {
		await setupMobileChat(page);
		await openModelPickerInPage(page);

		await page.getByTestId('model-picker-scrim').click({ force: true });

		const mountedNextFrame = await page.evaluate(() => {
			return new Promise<boolean>((resolve) => {
				requestAnimationFrame(() => {
					resolve(!!document.querySelector('[data-testid="model-picker-sheet"]'));
				});
			});
		});
		expect(mountedNextFrame).toBe(true);

		const ty = await readSheetTranslateY(page);
		expect(ty).toBeGreaterThan(0);
	});

	test('sidebar uses spring transform when opened on mobile', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await waitForChatSurface(page);
		await ensureSidebarClosed(page);

		const panel = page.getByTestId('threads-sidebar-panel');
		const menuBtn = page.getByRole('button', { name: 'Toggle Sessions Sidebar' });

		const closedTx = await panel.evaluate((el) => {
			const t = getComputedStyle(el).transform;
			if (t === 'none') return 0;
			const m = t.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([^,]+),/);
			return m ? Math.abs(parseFloat(m[1])) : 0;
		});
		if (Math.abs(closedTx) < 40) {
			await menuBtn.click();
			await expect
				.poll(
					async () =>
						panel.evaluate((el) => {
							const t = getComputedStyle(el).transform;
							if (t === 'none') return 0;
							const m = t.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([^,]+),/);
							return m ? Math.abs(parseFloat(m[1])) : 0;
						}),
					{ timeout: 2000 }
				)
				.toBeGreaterThan(40);
			await menuBtn.click();
			await expect
				.poll(
					async () =>
						panel.evaluate((el) => {
							const t = getComputedStyle(el).transform;
							if (t === 'none') return 0;
							const m = t.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([^,]+),/);
							return m ? Math.abs(parseFloat(m[1])) : 0;
						}),
					{ timeout: 2000 }
				)
				.toBeGreaterThan(40);
		}

		await menuBtn.click();

		await expect
			.poll(
				async () => {
					const transform = await panel.evaluate((el) => getComputedStyle(el).transform);
					return Math.abs(parseTranslateX(transform));
				},
				{ timeout: 2000 }
			)
			.toBeLessThan(8);
	});
});
