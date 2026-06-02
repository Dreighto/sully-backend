// Root → /chat redirect. Restored 2026-06-02 after commit 0728a59 removed
// it for a cosmetic Lighthouse `redirects` audit penalty — but the operator's
// Capacitor iOS shell loads its remote URL from server.url in
// capacitor.config.ts, which points at `/companion` (the base path root).
// Without this redirect that root returns 404 and the iOS app sits on a
// 404 page until rebuilt with a new server.url. This file is the one-line
// fix that unbreaks every already-installed TestFlight build.
//
// PWA / desktop browsers were unaffected because the manifest start_url is
// already `/companion/chat`; only the Capacitor shell hit the bare root.
import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';

export const load = () => {
	throw redirect(307, `${base}/chat`);
};
