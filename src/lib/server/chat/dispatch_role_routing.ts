import { DEFAULT_ROUTED_WORKER, resolveDispatchableWorker } from '$lib/server/worker-registry';

// ── Role-dispatch derivation (LOS role-dispatch) ────────────────────────────
// The auto/default path (operator named no worker, gate named no worker → the
// resolved worker falls to DEFAULT_ROUTED_WORKER) routes by ROLE so the kernel
// rotates workers by role + trust, instead of always pinning claude-code. An
// explicit @worker (or a model-gate/teacher-named worker) still PINS that worker.
const FRONTEND_REPO_RE = /logueos-sully|sully-ios/i;
const FRONTEND_SIGNAL_RE =
	/swift|ios|swiftui|xcode|\.svelte|frontend|\bUI\b|component|screen|view|layout|mobile/i;

/** FRONTEND when the target is the iOS app repo or the task reads frontend; else BACKEND. */
export function deriveRole(targetRepo: string, task: string): 'frontend' | 'backend' {
	if (FRONTEND_REPO_RE.test(targetRepo) || FRONTEND_SIGNAL_RE.test(task)) return 'frontend';
	return 'backend';
}

/** Pin when the operator explicitly named a dispatchable worker, OR the resolved
 *  worker is anything other than the routed default (i.e. a gate/model vote named
 *  one). Only the pure auto/default fallthrough → role-route. */
export function shouldPinWorker(userText: string, worker: string): boolean {
	return resolveDispatchableWorker(userText) != null || worker !== DEFAULT_ROUTED_WORKER;
}

export const ROLE_ROUTED_MSG = `On it — routing that to the best-fit worker now. I'll drop the answer right here when it's ready.`;
