import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';

// The companion IS the chat — root redirects straight to the chat surface.
export function load() {
	redirect(307, `${base}/chat`);
}
