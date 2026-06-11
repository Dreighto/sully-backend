// Reactive read model for work-surface UI — call once per component tree.
import type { Surface } from '$lib/types/workSurface';
import { surfaceStore } from '$lib/work-surface/surfaces.svelte';

const RECENT_COMPLETE_MS = 6000;

function countActiveWorkers(surfaces: Surface[]): number {
	let count = 0;
	for (const s of surfaces) {
		for (const w of s.task.workers) {
			if (w.status === 'active') count++;
		}
	}
	return count;
}

export function createWorkSurfaceView(getOpenSurfaceId: () => string | null) {
	const runningList = $derived(surfaceStore.items.filter((s) => s.status === 'running'));
	const needsYouList = $derived(surfaceStore.items.filter((s) => s.status === 'needs-you'));
	const doneList = $derived(surfaceStore.items.filter((s) => s.status === 'done'));

	const hasWork = $derived(
		runningList.length > 0 || needsYouList.length > 0 || doneList.length > 0
	);
	const hasRunning = $derived(runningList.length > 0);
	const hasNeedsYou = $derived(needsYouList.length > 0);

	let lastDoneCount = 0;
	let recentCompleteUntil = $state(0);
	let tick = $state(0);

	$effect(() => {
		const n = doneList.length;
		if (n > lastDoneCount) {
			recentCompleteUntil = Date.now() + RECENT_COMPLETE_MS;
			const timer = setTimeout(() => {
				tick++;
			}, RECENT_COMPLETE_MS + 50);
			lastDoneCount = n;
			return () => clearTimeout(timer);
		}
		lastDoneCount = n;
	});

	const isRecentComplete = $derived(tick >= 0 && recentCompleteUntil > Date.now());
	const showPill = $derived(hasRunning || hasNeedsYou || isRecentComplete);

	const activeWorkerCount = $derived.by(() =>
		countActiveWorkers([...runningList, ...needsYouList])
	);

	const pulseDuration = $derived.by(() => {
		// 0.6s has no ambient token (spec floor is 1s) — kept literal so the
		// 3+-worker urgency signal doesn't slow down; candidate for a spec rev.
		if (activeWorkerCount >= 3) return '0.6s';
		if (activeWorkerCount >= 1) return 'var(--dur-ambient)';
		return 'var(--dur-ambient-slow)';
	});

	const mostImportantSurface = $derived(needsYouList[0] ?? runningList[0] ?? doneList[0] ?? null);

	const mostImportantId = $derived(mostImportantSurface?.surfaceId ?? null);

	const currentSurface = $derived.by(() => {
		const openId = getOpenSurfaceId();
		const all = [...runningList, ...needsYouList, ...doneList];
		if (openId) {
			return all.find((s) => s.surfaceId === openId) ?? null;
		}
		return mostImportantSurface;
	});

	const pillAriaLabel = $derived(
		hasNeedsYou
			? `${needsYouList.length} surface${needsYouList.length === 1 ? '' : 's'} need attention — open Work Surface`
			: hasRunning
				? `${runningList.length} surface${runningList.length === 1 ? '' : 's'} running — open Work Surface`
				: 'Open Work Surface'
	);

	return {
		get runningList() {
			return runningList;
		},
		get needsYouList() {
			return needsYouList;
		},
		get doneList() {
			return doneList;
		},
		get hasWork() {
			return hasWork;
		},
		get hasRunning() {
			return hasRunning;
		},
		get hasNeedsYou() {
			return hasNeedsYou;
		},
		get isRecentComplete() {
			return isRecentComplete;
		},
		get showPill() {
			return showPill;
		},
		get pulseDuration() {
			return pulseDuration;
		},
		get mostImportantId() {
			return mostImportantId;
		},
		get currentSurface() {
			return currentSurface;
		},
		get pillAriaLabel() {
			return pillAriaLabel;
		}
	};
}
