import type { InteractiveAction } from '$lib/types/chat';

export type ActionRisk = 'routine' | 'destructive';

// Anchored patterns — substring matching caused a fail-OPEN hole (`rm -fr`,
// `rm  -rf` classed routine) and false-destructives (`git add` hit `dd `,
// `reproduce` hit `prod`). These use word boundaries + flexible whitespace/
// flag order so a genuinely destructive command can't slip past, and benign
// commands aren't needlessly held (in-house review, SUL-174).
const DESTRUCTIVE_REGEXES: readonly RegExp[] = [
	/\brm\s+(-\w*r|--recursive)/i, // rm -r / -rf / -fr / --recursive (any flag order)
	/\bch(mod|own)\s+.*-\w*r/i, // recursive chmod/chown
	/--force\b/i,
	/--hard\b/i,
	/\bpush\s+(--force|-f)\b/i,
	/\bdrop\s+(table|database)\b/i,
	/\btruncate\b/i,
	/\bdelete\s/i,
	/\bdeploy/i,
	/\bprod\b/i, // whole word — not "reproduce"/"product"
	/\bshutdown\b/i,
	/\breboot\b/i,
	/\bmigrate\b/i,
	/\bmkfs\b/i,
	/\bdd\s/i, // dd command — whole word, not "git add"
	/:emptytrash/i, // Plex — DELETES files (safety canon)
	/\bformat\s+[a-z]:/i // format C: etc.
];

/**
 * Classify operator-approval command risk for Approval Card v2 (SUL-174).
 * Conservative / fail-safe: empty, whitespace-only, or non-string → destructive.
 */
export function classifyActionRisk(command: string): ActionRisk {
	if (typeof command !== 'string') return 'destructive';
	const trimmed = command.trim();
	if (!trimmed) return 'destructive';
	for (const re of DESTRUCTIVE_REGEXES) {
		if (re.test(trimmed)) return 'destructive';
	}
	return 'routine';
}

/**
 * Set `risk` on a command-bearing InteractiveAction if it isn't already
 * present. Used on the READ path so every approval card carries a tier
 * regardless of who wrote the row (this backend or the external kernel).
 */
export function ensureActionRisk(action: InteractiveAction): InteractiveAction {
	if (action.risk || typeof action.command !== 'string') return action;
	return { ...action, risk: classifyActionRisk(action.command) };
}

/** Canonical factory for command-based InteractiveAction rows (pending approval). */
export function buildInteractiveAction(command: string, reason: string): InteractiveAction {
	return {
		command,
		reason,
		status: 'pending',
		risk: classifyActionRisk(command)
	};
}
