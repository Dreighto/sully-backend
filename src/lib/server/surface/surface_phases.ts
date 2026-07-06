import { inferStageFromAction } from '$lib/work-surface/chatBridge.svelte';
import type { PhaseKey, PhaseStatus, SeedPhase } from '$lib/work-surface/hybrid/hybrid-types';

/** Also used by surface_activity.ts's buildActivity — exported for that. */
export function stageToKey(stage: string | null): PhaseKey | null {
	if (!stage) return null;
	return stage.toLowerCase() as PhaseKey;
}

export function buildPhases(activityRows: any[], aggrStatus: string): SeedPhase[] {
	const pipelineStages = ['Read', 'Research', 'Build', 'Check', 'Approve', 'Reply'];
	const stageTimestamps: Record<string, { first: string | null; last: string | null }> = {};
	for (const stage of pipelineStages) stageTimestamps[stage] = { first: null, last: null };

	// Walk activity, recording which stages ACTUALLY occurred + the furthest reached.
	let highestIndex = -1;
	for (const row of activityRows) {
		const stage = inferStageFromAction(row.action);
		if (!stage) continue;
		const idx = pipelineStages.indexOf(stage);
		if (idx > highestIndex) highestIndex = idx;
		if (!stageTimestamps[stage].first) stageTimestamps[stage].first = row.timestamp;
		stageTimestamps[stage].last = row.timestamp;
	}

	const terminal = aggrStatus === 'done' || aggrStatus === 'failed' || aggrStatus === 'stopped';

	const phases: SeedPhase[] = pipelineStages.map((stage, index) => {
		const hadActivity = stageTimestamps[stage].first !== null;
		let status: PhaseStatus;
		let reason: string | undefined;

		if (index < highestIndex) {
			// Below the furthest-reached stage. A stage is 'done' ONLY if it
			// actually had activity; a stage with no activity was bypassed this
			// run → 'skipped' (NOT a fake green 'done'). This is what makes
			// Research / Approve truthful — they had no action vocabulary to
			// drive them, so on a Read→Build→Reply run they correctly read as
			// skipped instead of falsely done. (CDX critical #8 + truth-guard #4.)
			if (hadActivity) {
				status = 'done';
			} else {
				status = 'skipped';
				reason = `No ${stage} step this run`;
			}
		} else if (index === highestIndex) {
			// The frontier stage the worker is on / ended on. Each terminal aggr
			// must map honestly — a STOPPED task was interrupted mid-stage, so the
			// frontier is NOT 'done' (that re-introduces the green-done truth bug);
			// mark it skipped-with-reason. needs-you / blocked surface their own.
			if (aggrStatus === 'running') {
				status = 'active';
			} else if (aggrStatus === 'failed') {
				status = 'failed';
			} else if (aggrStatus === 'needs-you') {
				status = 'needs-you';
			} else if (aggrStatus === 'blocked') {
				status = 'blocked';
			} else if (aggrStatus === 'stopped') {
				status = 'skipped';
				reason = 'Stopped here';
			} else {
				status = 'done';
			}
		} else {
			// Above the frontier — not reached.
			if (terminal) {
				status = 'skipped';
				reason = 'Not reached this run';
			} else {
				status = 'pending';
			}
		}

		return {
			key: stageToKey(stage)!,
			status,
			startedAt: stageTimestamps[stage].first,
			endedAt: stageTimestamps[stage].last,
			reason: status === 'skipped' ? reason : undefined
		};
	});

	// Zero activity yet but in-flight → Read is the implicit active stage.
	if (highestIndex === -1 && aggrStatus === 'running') {
		phases[0].status = 'active';
	}

	return phases;
}
