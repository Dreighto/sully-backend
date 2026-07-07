import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

(async () => {
	console.log('=== STARTING AUTOMATED COMPANION FRONTEND AUDIT ===');
	const screenshotDir = '/home/dreighto/.gemini/antigravity-cli/brain/6313cb1e-ffe4-47b1-9e23-123cb7bbe94b';

	// Launch headless browser
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: 480, height: 800 }, // Mobile-first aspect ratio (since the companion is mobile-first)
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
	});
	const page = await context.newPage();

	// Set up handlers for console logs and errors
	const consoleMsgs = [];
	const errors = [];
	page.on('console', msg => {
		const txt = msg.text();
		consoleMsgs.push({ type: msg.type(), text: txt });
		console.log(`[BROWSER LOG ${msg.type()}]:`, txt);
	});
	page.on('pageerror', err => {
		errors.push(err.message);
		console.error('[BROWSER ERROR]:', err.message);
	});

	try {
		// 1. Load the Landing Chat Page
		console.log('1. Navigating to Companion Chat Page...');
		const response = await page.goto('http://127.0.0.1:18769/companion/chat');
		console.log(`Response status: ${response.status()}`);
		await page.waitForLoadState('networkidle');
		await page.waitForTimeout(1000); // Wait a second for animations

		// Capture the landing page screenshot
		const pathLanding = path.join(screenshotDir, 'companion_landing.png');
		await page.screenshot({ path: pathLanding });
		console.log(`Screenshot saved: ${pathLanding}`);

		// 2. Dump all button attributes for inventory
		const buttonsInfo = await page.evaluate(() => {
			return Array.from(document.querySelectorAll('button, a, input, textarea')).map(el => {
				const bbox = el.getBoundingClientRect();
				return {
					tagName: el.tagName,
					text: el.innerText ? el.innerText.trim().replace(/\n/g, ' ') : '',
					ariaLabel: el.getAttribute('aria-label') || '',
					title: el.getAttribute('title') || '',
					id: el.getAttribute('id') || '',
					classes: el.className,
					bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height }
				};
			});
		});
		console.log('\n--- DOM ELEMENT INVENTORY ---');
		console.log(JSON.stringify(buttonsInfo, null, 2));

		// 3. Test Sidebar Toggle Button
		console.log('\n3. Testing Sidebar Toggle Button...');
		const sidebarToggleSelector = 'button[aria-label="Toggle Sessions Sidebar"]';
		const toggleButtonExists = await page.evaluate(sel => !!document.querySelector(sel), sidebarToggleSelector);
		
		if (toggleButtonExists) {
			console.log('Sidebar toggle button found! Clicking it via evaluated click...');
			await page.evaluate(sel => document.querySelector(sel).click(), sidebarToggleSelector);
			await page.waitForTimeout(600); // Wait for transition
			
			// Take screenshot with open sidebar
			const pathSidebar = path.join(screenshotDir, 'companion_sidebar_open.png');
			await page.screenshot({ path: pathSidebar });
			console.log(`Sidebar screenshot saved: ${pathSidebar}`);

			// Verify if sidebar is open
			const isSidebarVisible = await page.evaluate(() => {
				const sidebar = document.querySelector('aside');
				if (!sidebar) return false;
				const style = window.getComputedStyle(sidebar);
				return style.transform !== 'none' || style.display !== 'none';
			});
			console.log(`Is sidebar visible in DOM? ${isSidebarVisible}`);

			// Close sidebar by clicking backdrop
			console.log('Closing sidebar by clicking backdrop...');
			await page.evaluate(() => {
				const backdrop = document.querySelector('button.bg-black\\/60') || document.querySelector('button[aria-label="Close sidebar"]');
				if (backdrop) backdrop.click();
			});
			await page.waitForTimeout(600); // Wait for close transition
		} else {
			console.warn('WARNING: Sidebar toggle button NOT found via aria-label!');
		}

		// 4. Test Model Picker Chip
		console.log('\n4. Testing Model Picker Button...');
		const modelPickerSelector = 'button[aria-label="Model picker"]';
		const modelPickerExists = await page.evaluate(sel => !!document.querySelector(sel), modelPickerSelector);
		if (modelPickerExists) {
			console.log('Model picker button found! Clicking it...');
			await page.evaluate(sel => document.querySelector(sel).click(), modelPickerSelector);
			await page.waitForTimeout(600);

			// Take screenshot with open model picker popover
			const pathModelPicker = path.join(screenshotDir, 'companion_model_picker_open.png');
			await page.screenshot({ path: pathModelPicker });
			console.log(`Model picker screenshot saved: ${pathModelPicker}`);

			// Check popover items
			const popoverItems = await page.evaluate(() => {
				const popover = document.querySelector('[data-popover]');
				if (!popover) return 'Popover container not found';
				return Array.from(popover.querySelectorAll('button')).map(btn => btn.innerText.trim().replace(/\n/g, ' '));
			});
			console.log('Model Picker Popover options:', popoverItems);

			// 5. Open Workspace Context Modal (Edit Sully's context)
			console.log('\n5. Testing Workspace Context Modal...');
			// Click context edit button in popover
			const contextBtnExists = await page.evaluate(() => {
				const btns = Array.from(document.querySelectorAll('button'));
				return btns.some(btn => btn.innerText.includes("Edit Sully's context"));
			});
			
			if (contextBtnExists) {
				console.log('Context button found! Clicking it to open modal...');
				await page.evaluate(() => {
					const btns = Array.from(document.querySelectorAll('button'));
					const contextBtn = btns.find(btn => btn.innerText.includes("Edit Sully's context"));
					if (contextBtn) contextBtn.click();
				});
				await page.waitForTimeout(1000); // Wait for fetch and modal animate in
				
				const pathContextModal = path.join(screenshotDir, 'companion_context_modal.png');
				await page.screenshot({ path: pathContextModal });
				console.log(`Workspace context modal screenshot saved: ${pathContextModal}`);

				// Verify modal text area is present
				const isModalOpen = await page.evaluate(() => {
					const modal = document.querySelector('[role="dialog"]') || document.querySelector('textarea[placeholder*="addendum"]');
					return !!modal;
				});
				console.log(`Is modal open? ${isModalOpen}`);

				// Close modal by clicking the Cancel button inside the modal!
				console.log('Closing workspace context modal by clicking Cancel button...');
				await page.evaluate(() => {
					// We find the Cancel button in the modal
					const modalDiv = document.querySelector('[role="presentation"]');
					if (modalDiv) {
						const cancelBtn = Array.from(modalDiv.querySelectorAll('button')).find(btn => btn.innerText.includes("CANCEL"));
						if (cancelBtn) {
							cancelBtn.click();
							return;
						}
					}
					// Fallback to Escape press or click outside
					if (modalDiv) modalDiv.click();
				});
				await page.waitForTimeout(600); // Wait for fade out
			} else {
				console.warn('WARNING: Edit Sully\'s context button NOT found in model picker popover!');
				await page.keyboard.press('Escape'); // Dismiss popover
				await page.waitForTimeout(300);
			}
		} else {
			console.warn('WARNING: Model picker button NOT found!');
		}

		// 6. Test Composer Actions Button (+)
		console.log('\n6. Testing Composer actions panel (+)...');
		const plusButtonSelector = 'button[aria-label="More actions"]';
		const plusButtonExists = await page.evaluate(sel => !!document.querySelector(sel), plusButtonSelector);
		if (plusButtonExists) {
			console.log('Plus button found! Clicking it to expand options...');
			await page.evaluate(sel => document.querySelector(sel).click(), plusButtonSelector);
			await page.waitForTimeout(600);

			const pathComposerActions = path.join(screenshotDir, 'companion_composer_actions.png');
			await page.screenshot({ path: pathComposerActions });
			console.log(`Composer actions screenshot saved: ${pathComposerActions}`);

			// Close composer actions
			console.log('Closing composer actions...');
			await page.evaluate(() => {
				const closeActBtn = document.querySelector('button[aria-label="Close actions"]');
				if (closeActBtn) closeActBtn.click();
			});
			await page.waitForTimeout(400);
		} else {
			console.warn('WARNING: Plus button not found!');
		}

		// 7. Check other buttons
		console.log('\n7. Checking buttons in composer...');
		const otherButtons = await page.evaluate(() => {
			const headphones = document.querySelector('button[aria-label="Hands-free continuous Talkback"]');
			const voice = document.querySelector('button[aria-label="Voice mode"]');
			return {
				talkbackPresent: !!headphones,
				voiceModePresent: !!voice
			};
		});
		console.log('Composer other buttons presence:', otherButtons);

		// Type text to morph the voice button into send button
		console.log('Typing test input in textarea...');
		const textareaSelector = 'textarea[placeholder*="Talk to Sully"]';
		const textareaExists = await page.evaluate(sel => !!document.querySelector(sel), textareaSelector);
		if (textareaExists) {
			await page.focus(textareaSelector);
			await page.type(textareaSelector, 'Hello Sully, this is an automated audit.');
			await page.waitForTimeout(500);

			// Capture screen to see text and Send button morph
			const pathTypedText = path.join(screenshotDir, 'companion_composer_typed.png');
			await page.screenshot({ path: pathTypedText });
			console.log(`Typed state screenshot saved: ${pathTypedText}`);

			// Confirm Send button is present
			const sendBtnExists = await page.evaluate(() => {
				const btn = document.querySelector('button[aria-label="Send Message"]');
				return !!btn;
			});
			console.log(`Send button morphed and present? ${sendBtnExists}`);
		}

	} catch (e) {
		console.error('CRITICAL AUDIT ERROR:', e);
	} finally {
		await browser.close();
		console.log('\n=== COMPLETED COMPANION FRONTEND AUDIT ===');
		console.log('Console warnings/errors detected:', JSON.stringify(consoleMsgs.filter(m => m.type === 'warning' || m.type === 'error'), null, 2));
		console.log('Unhandled errors detected:', JSON.stringify(errors, null, 2));
	}
})();
