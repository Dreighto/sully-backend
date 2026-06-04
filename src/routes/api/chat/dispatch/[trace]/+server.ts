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
	const job = getJob(traceId) ?? null;
	// Only real worker steps reach the UI — internal pipeline events (gate_evaluated,
	// synthesis_completed, …) stay server-side (P2 leak fix).
	const activity = getActivityForTrace(traceId, 200).filter((a) => isDisplayableAction(a.action));
	return json({ job, activity });
};
