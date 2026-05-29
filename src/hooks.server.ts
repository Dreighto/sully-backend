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
import { startCompletionPoller } from '$lib/server/completion_poller';
import { bootstrapCompanionDb } from '$lib/server/bootstrap';
import { runMode } from '$lib/server/config';

// Create the two kernel-made tables on a fresh companion DB BEFORE anything
// touches it. Idempotent; a no-op against the shared kernel DB in wired mode.
bootstrapCompanionDb();

// The completion poller tails the kernel's cc_completion_log.jsonl — a kernel
// artifact. In companion mode (kernelWired=false) there is no kernel to poll,
// so it never starts.
if (runMode.completionPoller) {
	startCompletionPoller();
}

export const handle: Handle = async ({ event, resolve }) => {
	return resolve(event);
};
