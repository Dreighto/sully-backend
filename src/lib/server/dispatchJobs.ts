// Wave 3 split (2026-07-06): this file used to hold every pending_jobs /
// Task-lifecycle concern directly (666 lines). It's now a re-export barrel
// over src/lib/server/dispatch_jobs/{job_types,job_db,job_create,
// job_transitions,job_proposals,job_queries}.ts — kept here so the ~36
// external import sites across the codebase need no path changes. The
// migration-guard `_ensured` singleton lives in exactly one file (job_db.ts).
export {
	type JobStatus,
	type PendingJob,
	PRE_DISPATCH_STATES,
	RUNNING_STATES
} from './dispatch_jobs/job_types';
export { proposeTask, createJob, getJob } from './dispatch_jobs/job_create';
export {
	markDispatched,
	markWorking,
	markDone,
	markFailed,
	markRetry,
	markAborted,
	markVerified,
	markSynthesized,
	markClassified,
	markSelfHandled
} from './dispatch_jobs/job_transitions';
export {
	type ProposalPayload,
	type PendingProposal,
	markGatedProposal,
	expireProposalsForThread,
	expireTaskById,
	getPendingProposal,
	getProposalByTaskId
} from './dispatch_jobs/job_proposals';
export {
	getActiveTaskForThread,
	getRunningTaskForThread,
	getJobsForThread,
	listInFlight,
	reapStaleJobs
} from './dispatch_jobs/job_queries';
