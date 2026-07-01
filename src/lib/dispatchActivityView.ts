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
//   2. isTerminalStatus — the SSE stream's terminal gate. A dispatch job only
//      genuinely FINISHES at a sink: 'synthesized' (Sully's reply row is
//      written) for success, or 'failed'/'aborted'. 'done' and 'verified' are
//      the worker-finished-but-PRE-synthesis states: the worker's output exists
//      but the synthesized reply row isn't written yet (~45s later). Treating
//      those as terminal closes the card ~45s BEFORE the answer surfaces, so
//      they are NON-terminal progress here — mirroring the poll route's hold in
//      dispatch/[trace]/+server.ts (with the same 90s-from-ended_at safety cap
//      applied by the stream route). (Fixes the premature card-close: P1.)

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

/** Genuine SUCCESS sink — Sully's synthesized reply row exists on-thread. */
const SUCCESS_TERMINAL = ['synthesized'] as const;
/** Genuine FAILURE sinks. */
const FAIL_TERMINAL = ['failed', 'aborted'] as const;
/** Worker finished but the synthesized reply row isn't written yet — NON-terminal
 *  progress. The card must keep streaming/polling until 'synthesized'; the stream
 *  route only forces these terminal via the 90s-from-ended_at safety cap. */
const PRE_SYNTH_PROGRESS = ['done', 'verified'] as const;

/** True once a job has reached a genuine terminal SINK (success OR failure).
 *  'done'/'verified' are deliberately excluded — they are pre-synthesis progress
 *  (the reply row isn't written yet), so the SSE terminal gate must NOT fire on
 *  them (it holds, mirroring the poll route). */
export function isTerminalStatus(s: string): boolean {
	return (
		(SUCCESS_TERMINAL as readonly string[]).includes(s) ||
		(FAIL_TERMINAL as readonly string[]).includes(s)
	);
}

/** True for a clean finish (vs failed/aborted). Includes the pre-synthesis
 *  worker-success states so that a safety-cap terminal on 'done'/'verified'
 *  (stalled synthesis) still gets the ✓ (not ✗) treatment. */
export function isSuccessStatus(s: string): boolean {
	return (
		(SUCCESS_TERMINAL as readonly string[]).includes(s) ||
		(PRE_SYNTH_PROGRESS as readonly string[]).includes(s)
	);
}

/** True if this raw activity action may be shown to the operator at all. */
export function isDisplayableAction(action: string): boolean {
	return !(HIDDEN_ACTIONS as readonly string[]).includes(action);
}

/** A short status line derived from the task's actual brief ("Audit the docs
 *  folder…"), or null when no brief is available. Capped so a long brief can't
 *  blow up the card. */
function briefLine(brief: string | null | undefined): string | null {
	const b = (brief || '').trim().replace(/\s+/g, ' ');
	if (!b) return null;
	const capped = b.length > 80 ? `${b.slice(0, 79).trimEnd()}…` : `${b}…`;
	return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/**
 * Map a raw worker activity row to a plain-English status line, or `null` to
 * hide it entirely. The `target` (file paths, commands, JSON) is intentionally
 * NEVER interpolated, and an unknown verb falls back to a generic phrase — a
 * non-coder must never see a raw action name or payload. When the task `brief`
 * is supplied, run-state lines derive from it instead of a canned claim (the
 * old hardcoded test-running copy lied whenever the worker ran anything else —
 * LOS-191).
 */
export function friendlyStep(
	action: string,
	_target: string | null,
	brief?: string | null
): string | null {
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
			return briefLine(brief) ?? 'Running a command…';
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
