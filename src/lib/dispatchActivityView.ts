// What the operator (a non-coder) is allowed to see about a background worker
// task, and how raw lifecycle data maps to plain English. Two distinct concerns
// live here so the rules can't drift between the SSE stream, the reconcile
// endpoint, and the card component:
//
//   1. DISPLAYABLE_WORKER_ACTIONS — the ONLY chat_activity actions that may
//      surface in the UI. Everything else in that table (gate_evaluated,
//      synthesis_completed, task_proposed, …) is internal bookkeeping and must
//      never reach the screen. (Fixes the raw-JSON leak: P2.)
//   2. isTerminalStatus — a job is finished when it reaches ANY terminal state,
//      including 'synthesized'/'verified', which the old hard-coded
//      ['done','failed','aborted'] check missed → the card span "working"
//      forever. (Fixes the stuck timer: P1.)

/** The only worker actions a non-coder should ever see in the Task card. */
export const DISPLAYABLE_WORKER_ACTIONS = ['reading', 'edited', 'ran', 'thinking'] as const;

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

/** True if this raw activity action is safe to show the operator at all. */
export function isDisplayableAction(action: string): boolean {
	return (DISPLAYABLE_WORKER_ACTIONS as readonly string[]).includes(action);
}

/**
 * Map a raw worker activity row to a plain-English status line for the live
 * card, or `null` to hide it entirely. The `target` (file paths, JSON blobs) is
 * intentionally NOT interpolated — a non-coder never sees a path or a payload.
 */
export function friendlyStep(action: string, _target: string | null): string | null {
	switch (action) {
		case 'reading':
			return 'Reading the files…';
		case 'edited':
			return 'Making changes…';
		case 'ran':
			return 'Running the tests…';
		case 'thinking':
			return 'Working it through…';
		default:
			return null; // internal event — never shown
	}
}
