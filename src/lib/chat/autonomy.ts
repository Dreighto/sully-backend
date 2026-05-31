export type Autonomy = 'ask' | 'auto-safe' | 'full-auto';
// Operator directive 2026-05-31: full-auto by default — the cloud teacher is
// capable, governance (gatekeeper / kill-switch / brakes / cost-rule) still
// wraps every dispatch, and workers run skip-permissions so they never hang.
// Sully dispatches in the background; flip to 'ask' in Settings for one-tap chips.
export const AUTONOMY_DEFAULT: Autonomy = 'full-auto';
const VALID: Autonomy[] = ['ask', 'auto-safe', 'full-auto'];

export function normalizeAutonomy(raw: string | null | undefined): Autonomy {
	return VALID.includes((raw || '') as Autonomy) ? (raw as Autonomy) : AUTONOMY_DEFAULT;
}
