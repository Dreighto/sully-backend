import type { TaskWorker } from '$lib/types/workSurface';

/** Per-identity brand colour — brand-TRUE per operator note 2026-06-11
 *  ("icon color should represent the actual color of the logo"); supersedes
 *  the 2026-06-06 assigned tints. Identity, not role/status. Matches BOTH the
 *  kernel short ids ('agy', 'dpsk', …) and the legacy long names (LOS-205
 *  alias treatment — same id set as chatBridge's resolveWorkerTemplate).
 *  glm/ki hexes are the lobe-icons registry primaries (Zhipu #3859FF,
 *  Qwen #615CED). Unknown workers fall back to neutral chrome (--ui), never
 *  a semantic colour. */
export function workerBrandColor(identity?: string, shortCode?: string): string {
	const id = (identity || '').toLowerCase();
	// shortCode is only a fallback signal when NO identity arrived at all — an
	// id that resolved to honest-unknown must not pick up a brand colour via a
	// shortCode collision (CR finding, PR #59).
	const code = id ? '' : (shortCode || '').toUpperCase();
	if (id === 'claude-code' || id === 'claude' || code === 'CC') return '#d97757';
	if (id === 'agy' || id === 'antigravity' || code === 'AGY') return '#a855f7';
	if (id === 'cdx' || id === 'codex' || code === 'CDX') return '#9ca3af';
	if (id === 'dpsk' || id === 'deepseek' || code === 'DPSK') return '#4d6bfe';
	if (id === 'gmi' || id === 'gemini' || code === 'GMI') return '#8e75b2';
	if (id === 'glm' || code === 'GLM') return '#3859ff';
	if (id === 'ki' || id === 'qwen' || code === 'KI') return '#615ced';
	if (id === 'cur' || id === 'cursor' || code === 'CUR') return '#a8a29e';
	return 'var(--ui)';
}

/** Step text hints wrap-up — faster shared heartbeat across graph / row / registry. */
export function workerBreathFinishing(worker: Pick<TaskWorker, 'status' | 'step'>): boolean {
	if (worker.status !== 'active') return false;
	const step = (worker.step ?? '').toLowerCase();
	return /validat|verif|check|render|test|commit|final|wrapp|audit|confirm|polish/.test(step);
}

export function workerBreathDelay(index: number): string {
	return index % 2 === 0 ? '0s' : '0.35s';
}

/** Packet glide loop duration — TASK land pulse syncs to this. */
export function packetGlideDuration(motionType?: string): string | null {
	switch (motionType) {
		case 'researching':
			return '7.5s';
		case 'building':
			return '2s';
		case 'verifying':
			return '1s';
		default:
			return null;
	}
}
