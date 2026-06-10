/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

const CACHE_NAME = `cache-${version}`;
const APP_START_URL = '/companion/chat';

// Combine build artifacts (JS, CSS, static files) for comprehensive pre-caching
const ASSETS = [...build, ...files];

self.addEventListener('install', (event: any) => {
	async function preCache() {
		const cache = await caches.open(CACHE_NAME);
		await cache.addAll(ASSETS);
	}
	// Do not skipWaiting automatically. Immediate activation can delete the
	// currently-open PWA's old hashed assets while the page is still running,
	// which turns a normal app update into missing JS/CSS requests on iOS.
	// The client shows an update banner and sends SKIP_WAITING after a tap.
	event.waitUntil(preCache());
});

self.addEventListener('activate', (event: any) => {
	async function deleteOldCaches() {
		const keys = await caches.keys();
		for (const key of keys) {
			if (key !== CACHE_NAME) {
				await caches.delete(key);
			}
		}
	}
	// Enable Navigation Preload (Chrome 59+, Safari 15.4+, FF 99+). Without
	// this, the browser blocks the navigation request until the SW boots,
	// then the SW calls fetch() — Lighthouse + real users see this as a
	// multi-hop delay (the "Eliminate document.write / chained redirect"
	// shape). With preload enabled, the network request fires in parallel
	// with SW boot, so the response arrives ~as fast as a no-SW page.
	async function enablePreload() {
		const reg = (self as any).registration;
		if (reg?.navigationPreload) {
			try {
				await reg.navigationPreload.enable();
			} catch {
				/* unsupported on this browser — fall through to plain fetch */
			}
		}
	}
	// Claim immediate control to enable offline shell booting on first visit
	self.clients.claim();
	event.waitUntil(Promise.all([deleteOldCaches(), enablePreload()]));
});

self.addEventListener('message', (event: any) => {
	if (event.data?.type === 'SKIP_WAITING') {
		(self as any).skipWaiting();
	}
});

// Push notification handler (PR 6 — iOS 2026 hardenings).
//
// event.waitUntil wrapping is NON-NEGOTIABLE: iOS Safari kills the push
// subscription after 3 consecutive silent pushes if showNotification is not
// wrapped in waitUntil. Verified per Decision Log entry 10.
//
// iOS 18.4+ Declarative Web Push: Apple displays notifications directly from
// the payload (title/body/icon at root level) without invoking this handler.
// This handler remains as the fallback for older iOS, Chrome, and Firefox.
self.addEventListener('push', (event: any) => {
	event.waitUntil(
		(async () => {
			const data = event.data?.json() ?? {};
			await (self as any).registration.showNotification(data.title || 'LogueOS', {
				body: data.body || '',
				icon: '/companion/favicon.png',
				vibrate: [100, 50, 100],
				data: { url: data.data?.url || data.url || APP_START_URL }
			});
		})()
	);
});

self.addEventListener('notificationclick', (event: any) => {
	event.notification.close();
	const targetUrl: string = event.notification.data?.url || APP_START_URL;
	const sw = self as any;
	event.waitUntil(
		(async () => {
			// WARM (app already open): focus the existing client and hand it the
			// deep-link via postMessage so it switches to the exact thread + focuses
			// the task card WITHOUT a full reload. On iOS a bare openWindow() only
			// refocuses the running PWA and never navigates, so the tap would land on
			// whatever thread was already showing. matchAll only ever returns
			// same-origin window clients.
			const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			for (const client of wins) {
				if ('focus' in client) {
					try {
						await client.focus();
					} catch {
						/* focus can reject if another window grabbed it — fall through */
					}
					try {
						client.postMessage({ type: 'deep-link', url: targetUrl });
					} catch {
						/* client gone — fall through to openWindow */
					}
					return;
				}
			}
			// COLD-START (app not running): open a fresh window at the deep-link. The
			// server load() resolves the thread from ?thread= (restore order) and the
			// client reads trace_id on mount to focus the task card.
			await sw.clients.openWindow(targetUrl);
		})()
	);
});

self.addEventListener('fetch', (event: any) => {
	// Skip non-GET requests (e.g. POST for dispatch actions)
	if (event.request.method !== 'GET') return;

	const url = new URL(event.request.url);

	// Only ever touch same-origin requests. Cross-origin (Anthropic, Gemini,
	// AssemblyAI, ElevenLabs, etc.) must hit the network untouched.
	if (url.origin !== self.location.origin) return;

	// CRITICAL: never intercept API calls, SvelteKit data requests, or websockets.
	// The previous handler returned a plain-text 503 ("Network connection
	// unavailable.") on ANY failed non-asset fetch. For /api/* and SvelteKit's
	// __data.json the client expects JSON — a text/plain body fails to parse and
	// the raw string renders on screen as the page. Worse: on iOS PWA the SW can
	// intercept a transient nav-data fetch and surface that string even when the
	// server is healthy. Let these pass through to the network so SvelteKit's
	// router and the app's own try/catch see the REAL result.
	const isData =
		url.pathname.includes('/api/') ||
		url.pathname.endsWith('/__data.json') ||
		url.searchParams.has('x-sveltekit-invalidated') ||
		url.pathname.includes('/ws');
	if (isData) return; // browser-default fetch, no SW involvement

	// Cache-first for immutable build assets — instant load, safe to serve stale.
	const isAsset =
		ASSETS.includes(url.pathname) || url.pathname.startsWith('/companion/_app/immutable/');
	if (isAsset) {
		event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
		return;
	}

	// Navigation (HTML document) requests: use the navigation preload response
	// if available (parallelizes the network request with SW boot — no apparent
	// redirect chain to Lighthouse), otherwise fetch network-first. Fall back to
	// the cached app shell so the PWA still boots offline. NEVER return a plain-
	// text error body for a navigation — that's what painted "Network connection
	// unavailable." across the whole screen.
	if (event.request.mode === 'navigate') {
		event.respondWith(
			(async () => {
				try {
					// Preload response races with SW boot and arrives first when the
					// browser supports navigation preload (Chrome 59+, Safari 15.4+,
					// FF 99+). Falls through to a regular fetch on older browsers.
					const preload: Response | undefined = await event.preloadResponse;
					const response = preload || (await fetch(event.request));
					if (response.status === 200) {
						const clone = response.clone();
						caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
					}
					return response;
				} catch {
					const cached = await caches.match(event.request);
					if (cached) return cached;
					const shell = (await caches.match(APP_START_URL)) || (await caches.match('/companion'));
					if (shell) return shell;
					return new Response(
						'<!doctype html><meta charset="utf-8"><body style="background:#050505;color:#a1a1aa;font-family:system-ui;padding:2rem">Offline — reconnect to load Companion.</body>',
						{ status: 503, headers: { 'Content-Type': 'text/html' } }
					);
				}
			})()
		);
		return;
	}

	// Everything else (fonts, images, misc same-origin GETs): network-first with
	// cache fallback, and on total failure return a real network error rather
	// than a synthetic body that could be mis-parsed.
	event.respondWith(
		fetch(event.request)
			.then((response) => {
				if (response.status === 200) {
					const clone = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
				}
				return response;
			})
			.catch(async () => {
				const cached = await caches.match(event.request);
				return cached || Response.error();
			})
	);
});
