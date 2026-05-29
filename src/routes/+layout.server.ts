// Layout-level server load so the kill-switch state is available to the
// header on every page (not just /settings). The header renders a small
// ACTIVE pill so the operator sees the system state regardless of which
// tab they are on. Uses the *safe* read variant — a transient disk error
// must not break navigation across the rest of the Console.

import type { LayoutServerLoad } from './$types';
import { readKillSwitchStateSafe } from '$lib/server/kill-switch';

export const load: LayoutServerLoad = async () => ({
	killSwitch: await readKillSwitchStateSafe()
});
