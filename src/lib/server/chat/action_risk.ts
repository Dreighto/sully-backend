import type { InteractiveAction } from '$lib/types/chat';

export type ActionRisk = 'routine' | 'destructive';

/** Case-insensitive substring patterns that classify a command as destructive (fail-safe). */
const DESTRUCTIVE_PATTERNS: readonly string[] = [
	'rm -rf',
	'rm -r',
	'--force',
	'--hard',
	'push --force',
	'drop ',
	'drop table',
	'truncate',
	'delete ',
	'deploy',
	'prod',
	'shutdown',
	'reboot',
	'migrate',
	'mkfs',
	'dd ',
	':emptytrash',
	'chmod -r',
	'chown -r'
];

/**
 * Classify operator-approval command risk for Approval Card v2 (SUL-174).
 * Conservative: empty, whitespace-only, or unknown → destructive.
 */
export function classifyActionRisk(command: string): ActionRisk {
	if (typeof command !== 'string') return 'destructive';
	const trimmed = command.trim();
	if (!trimmed) return 'destructive';
	const lower = trimmed.toLowerCase();
	for (const pattern of DESTRUCTIVE_PATTERNS) {
		if (lower.includes(pattern)) return 'destructive';
	}
	return 'routine';
}

/** Canonical factory for command-based InteractiveAction rows (pending operator approval). */
export function buildInteractiveAction(command: string, reason: string): InteractiveAction {
	return {
		command,
		reason,
		status: 'pending',
		risk: classifyActionRisk(command)
	};
}
