// What the operator (a non-coder) is allowed to see about a background worker
// task, and how raw lifecycle data maps to plain English. Two distinct concerns
// live here so the rules can't drift between the SSE stream, the reconcile
// endpoint, and the card component:
//
//   1. HIDDEN_ACTIONS — internal lifecycle/journal events (Sully's own pipeline)
//      plus the terminal markers. These must NEVER surface as a live "step".
//      Everything else in chat_activity is a real worker progress step and is
//      mapped to a friendly phrase (raw verb/target never shown). Deny-listing
//      the KNOWN-finite internal set (vs allow-listing worker verbs) is robust
//      to worker vocabulary drift — e.g. the worker emits 'running', not 'ran'.
//      (Fixes the raw-JSON leak: P2.)
//   2. isTerminalStatus — a job is finished when it reaches ANY terminal state,
//      including 'synthesized'/'verified', which the old hard-coded
//      ['done','failed','aborted'] check missed → the card span "working"
//      forever. (Fixes the stuck timer: P1.)

/** Internal events + terminal markers that must never appear as a card step. */
export const HIDDEN_ACTIONS = [
	// Sully's own turn pipeline (logTaskEvent vocabulary)
	'task_proposed',
	'classifier_ran',
	'gate_evaluated',
	'brakes_evaluated',
	'provider_attempted',
	'provider_fell_through',
	'tool_invoked',
	'tool_result',
	'guardrail_triggered',
	'reply_persisted',
	'synthesis_started',
	'synthesis_completed',
	// terminal markers — the card flips via job status, not a step line
	'completed',
	'failed'
] as const;

const SUCCESS_TERMINAL = ['done', 'verified', 'synthesized'] as const;
const FAIL_TERMINAL = ['failed', 'aborted'] as const;

/** True once a job has reached any terminal state (success OR failure). */
export function isTerminalStatus(s: string): boolean {
	return (
		(SUCCESS_TERMINAL as readonly string[]).includes(s) ||
		(FAIL_TERMINAL as readonly string[]).includes(s)
	);
}

/** True for a clean finish (vs failed/aborted). Drives the ✓ vs ✗ treatment. */
export function isSuccessStatus(s: string): boolean {
	return (SUCCESS_TERMINAL as readonly string[]).includes(s);
}

/** True if this raw activity action may be shown to the operator at all. */
export function isDisplayableAction(action: string): boolean {
	return !(HIDDEN_ACTIONS as readonly string[]).includes(action);
}

/**
 * Map a raw worker activity row to a plain-English status line, or `null` to
 * hide it entirely. The `target` (file paths, commands, JSON) is intentionally
 * NEVER interpolated, and an unknown verb falls back to a generic phrase — a
 * non-coder must never see a raw action name or payload.
 */
export function friendlyStep(action: string, _target: string | null): string | null {
	if (!isDisplayableAction(action)) return null;
	switch (action) {
		case 'reading':
		case 'read':
			return 'Reading the files…';
		case 'editing':
		case 'edited':
		case 'writing':
		case 'wrote':
			return 'Making changes…';
		case 'running':
		case 'ran':
		case 'testing':
			return 'Running the tests…';
		case 'searching':
			return 'Searching…';
		case 'fetching':
			return 'Looking something up…';
		case 'building':
			return 'Building…';
		case 'thinking':
			return 'Working it through…';
		default:
			return 'Working on it…'; // never expose the raw verb/target
	}
}
