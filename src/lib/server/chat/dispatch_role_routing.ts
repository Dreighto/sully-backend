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

// ── Worker-task capability guard ────────────────────────────────────────────
// The aider workers (DPSK/KI/GLM/AGY/CDX) can ONLY edit code in a repo — no
// shell, no live-system access. Named for a shell/live task (a speed test, a
// systems check, running a script) they ghost: they ask for files and stop. So
// when the operator explicitly PINS such a worker to such a task, we LOCK the
// dispatch and inform him instead of sending it to fail (operator 2026-07-08).
const CODE_ONLY_WORKER_RE = /^(dpsk|deepseek|ki|qwen|glm|agy|antigravity|cdx|codex)$/i;
const NON_CODE_TASK_RE =
	/speed\s*test|internet.*(slow|speed|fast)|bandwidth|\bping\b|latency|how fast|why is .*(slow|down)|systems? (check|diagnostic)|check (the |a )?(service|status|disk|network)|run (a |the )?(command|script|diagnostic)/i;

/** True when a code-only worker was named for a task that needs a shell / the
 *  live system — it cannot run it and would ghost. */
export function codeOnlyWorkerCantRun(worker: string, task: string): boolean {
	return CODE_ONLY_WORKER_RE.test((worker || '').trim()) && NON_CODE_TASK_RE.test(task || '');
}

/** True when the task is a light connection/speed check Sully can run itself. */
export function isSelfServeSpeedTask(task: string): boolean {
	return /speed\s*test|internet.*(slow|speed|fast)|bandwidth|how fast/i.test(task || '');
}
