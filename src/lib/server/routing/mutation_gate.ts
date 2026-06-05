// The Mutation Gate (spec Contract 2). Pure read of the active task — decides
// whether a turn taken WHILE A TASK IS RUNNING is plain conversation or a
// work-intent that must NOT silently touch the running task. Pre-dispatch
// (gated proposal) tasks are left to the existing ask-before-dispatch flow.
import { getActiveTaskForThread, RUNNING_STATES, type PendingJob } from '$lib/server/dispatchJobs';

export type MutationClass = 'NO_ACTIVE_TASK' | 'CONVERSATIONAL_ONLY' | 'RUNNING_WORK_INTENT';
export interface MutationGateResult {
	classification: MutationClass;
	activeTaskId: string | null;
	activeTaskStatus: string | null;
}

// Work-intent signal: imperative verbs with an object, or an @mention. Mirrors
// the spirit of decide()'s value gate but local + cheap. Conservative — when
// unsure, treat as conversation (safe: we never silently mutate; worst case a
// real work request during a running task is answered as chat, which the
// operator can re-issue once the task finishes).
const WORK_INTENT_RE =
	/@cc\b|@agy\b|@gemini\b|\b(build|implement|create|generate|add|write|fix|patch|refactor|audit|review|run|inspect|check|verify|diagnose|deploy|migrate|update|change|delete|remove|test|investigate)\b/i;

export function runMutationGate(threadId: string, userText: string): MutationGateResult {
	const active: PendingJob | null = getActiveTaskForThread(threadId);
	if (!active)
		return { classification: 'NO_ACTIVE_TASK', activeTaskId: null, activeTaskStatus: null };
	// Only RUNNING tasks gate here; pre-dispatch (gated proposals) are handled by
	// ask-before-dispatch, so the gate is a no-op for them.
	if (!RUNNING_STATES.has(active.status)) {
		return { classification: 'NO_ACTIVE_TASK', activeTaskId: null, activeTaskStatus: null };
	}
	const work = WORK_INTENT_RE.test(userText || '');
	return {
		classification: work ? 'RUNNING_WORK_INTENT' : 'CONVERSATIONAL_ONLY',
		activeTaskId: active.trace_id,
		activeTaskStatus: active.status
	};
}
