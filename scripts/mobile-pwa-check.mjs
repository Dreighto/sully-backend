import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const baseUrl = process.env.COMPANION_URL || 'http://127.0.0.1:18769/companion/chat';
const chromeCandidates = [
	process.env.CHROME_BIN,
	'/snap/bin/chromium',
	'chromium',
	'chromium-browser',
	'google-chrome'
].filter(Boolean);

async function findChrome() {
	for (const candidate of chromeCandidates) {
		if (candidate.includes('/')) {
			try {
				await access(candidate);
				return candidate;
			} catch {
				continue;
			}
		}
		return candidate;
	}
	throw new Error('No Chromium binary found. Set CHROME_BIN to run this check.');
}

function connectDebugger(url) {
	const ws = new WebSocket(url);
	const pending = new Map();
	let id = 0;

	ws.on('message', (data) => {
		const msg = JSON.parse(data);
		if (!msg.id || !pending.has(msg.id)) return;
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
	});

	const opened = new Promise((resolve) => ws.once('open', resolve));
	return {
		opened,
		close: () => ws.close(),
		send(method, params = {}) {
			return new Promise((resolve, reject) => {
				const msgId = ++id;
				pending.set(msgId, { resolve, reject });
				ws.send(JSON.stringify({ id: msgId, method, params }));
			});
		}
	};
}

async function getJson(url, attempts = 30) {
	let lastError;
	for (let i = 0; i < attempts; i += 1) {
		try {
			const response = await fetch(url);
			if (response.ok) return await response.json();
		} catch (error) {
			lastError = error;
		}
		await delay(100);
	}
	throw lastError || new Error(`Failed to fetch ${url}`);
}

async function runViewport(page, width, height) {
	await page.send('Emulation.setDeviceMetricsOverride', {
		width,
		height,
		deviceScaleFactor: 3,
		mobile: true
	});
	await page.send('Page.navigate', { url: baseUrl });
	await delay(1200);

	const evaluate = async (expression) => {
		const result = await page.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true
		});
		return result.result.value;
	};

	const closed = await evaluate(`(() => {
		const vw = window.innerWidth;
		const rect = (el) => {
			const r = el.getBoundingClientRect();
			return { left: r.left, right: r.right, width: r.width, height: r.height };
		};
		const model = document.querySelector('[aria-label="Model picker"]');
		const header = document.querySelector('header');
		const toolbar = model?.closest('header > div:last-child');
		const feed = document.querySelector('main [data-chat-feed], main .overflow-y-auto');
		const entries = { header, toolbar, model };
		return {
			width: vw,
			docScrollWidth: document.documentElement.scrollWidth,
			bodyScrollWidth: document.body.scrollWidth,
			bodyOverflow: getComputedStyle(document.body).overflow,
			htmlOverflow: getComputedStyle(document.documentElement).overflow,
			feedOverflowY: feed ? getComputedStyle(feed).overflowY : null,
			rects: Object.fromEntries(Object.entries(entries).map(([key, el]) => [key, rect(el)])),
			overflow: Object.fromEntries(Object.entries(entries).map(([key, el]) => {
				const r = el.getBoundingClientRect();
				return [key, r.left < 0 || r.right > vw];
			}))
		};
	})()`);

	await evaluate(`document.querySelector('[aria-label="Model picker"]').click()`);
	await delay(150);
	const modelOpen = await evaluate(`(() => {
		const vw = window.innerWidth;
		const p = document.querySelector('[data-popover]');
		const r = p.getBoundingClientRect();
		return { left: r.left, right: r.right, width: r.width, overflows: r.left < 0 || r.right > vw };
	})()`);

	const failures = [];
	if (closed.docScrollWidth > width)
		failures.push(`document width ${closed.docScrollWidth} exceeds ${width}`);
	if (closed.bodyScrollWidth > width)
		failures.push(`body width ${closed.bodyScrollWidth} exceeds ${width}`);
	for (const [key, overflows] of Object.entries(closed.overflow)) {
		if (overflows) failures.push(`${key} overflows viewport`);
	}
	if (modelOpen.overflows) failures.push('model popover overflows viewport');
	if (closed.bodyOverflow !== 'hidden' || closed.htmlOverflow !== 'hidden') {
		failures.push(
			`page shell overflow is ${closed.htmlOverflow}/${closed.bodyOverflow}, expected hidden/hidden`
		);
	}
	if (closed.feedOverflowY !== 'auto')
		failures.push(`chat feed overflow-y is ${closed.feedOverflowY}, expected auto`);

	return { width, closed, modelOpen, failures };
}

const chrome = await findChrome();
const userDataDir = `/tmp/companion-mobile-pwa-${process.pid}`;
const browser = spawn(
	chrome,
	[
		'--headless',
		'--no-sandbox',
		'--disable-gpu',
		'--remote-debugging-port=9224',
		`--user-data-dir=${userDataDir}`,
		'--window-size=440,956',
		baseUrl
	],
	{ stdio: ['ignore', 'pipe', 'pipe'] }
);

try {
	await getJson('http://127.0.0.1:9224/json/version');
	const targets = await getJson('http://127.0.0.1:9224/json');
	const target = targets.find((item) => item.type === 'page');
	if (!target) throw new Error('No Chromium page target found');

	const page = connectDebugger(target.webSocketDebuggerUrl);
	await page.opened;
	await page.send('Runtime.enable');
	await page.send('Page.enable');

	const results = [];
	for (const viewport of [
		[375, 812],
		[430, 932],
		[440, 956]
	]) {
		results.push(await runViewport(page, viewport[0], viewport[1]));
	}

	page.close();
	console.log(JSON.stringify(results, null, 2));

	const failures = results.flatMap((result) =>
		result.failures.map((failure) => `${result.width}px: ${failure}`)
	);
	if (failures.length > 0) {
		console.error(`Mobile PWA check failed:\n${failures.join('\n')}`);
		process.exitCode = 1;
	}
} finally {
	browser.kill('SIGTERM');
}
