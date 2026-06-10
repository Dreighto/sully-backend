// Tailscale is the auth boundary for the Console.
//
// Tailscale Funnel exposes the Console publicly, but the *.ts.net hostname
// is not advertised anywhere, and all LLM credentials are server-side.
// A cookie-based gate on top was attempted (2026-05-28) and removed after
// research confirmed it is reliably broken on iOS PWA:
//   - iOS Safari has known TLS issues with *.ts.net Funnel endpoints (GH #19147)
//   - iOS 17.4+/18 WebKit regressions cause navigation failures in standalone mode
//   - SameSite=Lax + 302 redirect + Service Worker breaks cookie delivery on iOS
//   - Cookie set in Safari does NOT reliably carry into the installed PWA instance
//
// Security model: Tailscale ACLs + undisclosed Funnel hostname = sufficient
// for a single-operator personal dashboard. No app-level auth layer needed.

import type { Handle } from '@sveltejs/kit';
import { base } from '$app/paths';
import { startCompletionPoller } from '$lib/server/completion_poller';
import { startStaleJobReaper } from '$lib/server/staleJobSweep';
import { bootstrapCompanionDb } from '$lib/server/bootstrap';
import { runMode } from '$lib/server/config';

// Create the two kernel-made tables on a fresh companion DB BEFORE anything
// touches it. Idempotent; a no-op against the shared kernel DB in wired mode.
bootstrapCompanionDb();

// The completion poller tails the kernel's cc_completion_log.jsonl. Wired mode
// uses it for completion pushes; companion-dispatch mode uses it as the
// terminal bridge (LOS-196) that reconciles kernel terminal markers into
// pending_jobs. With neither, there is nothing to tail.
if (runMode.completionPoller || runMode.companionDispatchEnabled) {
	startCompletionPoller();
}

// Clock-driven stale-job reaper (LOS-196): reaping must never depend on a
// client being open. Same gate as the /api/chat/activity GET piggyback it
// backs up.
if (runMode.kernelWired || runMode.companionDispatchEnabled) {
	startStaleJobReaper();
}

// Vite emits hashed asset filenames under ${base}/_app/immutable/* — content-addressed,
// so they're safe to cache for a year. adapter-node does NOT set this header by default;
// without it, iOS PWA + Tailscale Funnel re-fetch every JS/CSS chunk on each cold load.
// The startsWith check on event.url.pathname guarantees the header lands ONLY on hashed
// asset responses — HTML page renders, /api/*, and any SSR'd content fall through untouched.
const IMMUTABLE_PREFIX = `${base}/_app/immutable/`;

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	if (event.url.pathname.startsWith(IMMUTABLE_PREFIX)) {
		response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
	}
	return response;
};
