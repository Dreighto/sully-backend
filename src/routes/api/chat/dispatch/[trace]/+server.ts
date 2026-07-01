import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runMode } from '$lib/server/config';
import { getJob } from '$lib/server/dispatchJobs';
import { getActivityForTrace } from '$lib/server/chatActivity';
import { isDisplayableAction } from '$lib/dispatchActivityView';

export const GET: RequestHandler = async ({ params }) => {
	if (!runMode.companionDispatchEnabled) return json({ job: null });
	const traceId = (params.trace || '').trim();
	if (!traceId) return json({ error: 'trace required' }, { status: 400 });
	let job = getJob(traceId) ?? null;
	// markDone flips status→'done' BEFORE closeOutTask promotes the artifact, and
	// markVerified flips it →'verified' ~45s BEFORE the synthesized reply row is
	// written. Either raw status makes the work card go terminal and stop its short
	// reply-hydration window before the answer exists, so the completed reply never
	// surfaces on-thread. Hold BOTH 'done' and 'verified' as non-terminal 'working'
	// until the job reaches 'synthesized' (artifact written + reply row exists).
	// markVerified does NOT bump ended_at, so ended_at stays fixed at markDone time;
	// a 90s safety cap from ended_at still lets the card terminate if closeOutTask
	// never completes, so the card can never poll forever.
	if (job && (job.status === 'done' || job.status === 'verified')) {
		const endedAt = job.ended_at ? Date.parse(String(job.ended_at)) : 0;
		const sinceMs = endedAt ? Date.now() - endedAt : Number.POSITIVE_INFINITY;
		if (sinceMs < 90_000) job = { ...job, status: 'working' };
	}
	// Only real worker steps reach the UI — internal pipeline events (gate_evaluated,
	// synthesis_completed, …) stay server-side (P2 leak fix).
	const activity = getActivityForTrace(traceId, 200).filter((a) => isDisplayableAction(a.action));
	return json({ job, activity });
};
