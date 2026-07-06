import type { AggrStatus } from '$lib/work-surface/hybrid/hybrid-types';

/**
 * What the operator needs to confirm, for a 'needs-you' surface. CDX critical
 * #2: the old version read a non-existent `payload` column off a gate_evaluated
 * activity row, so `needs` was always undefined and the needs-you banner showed
 * no actual ask. The real source is pending_jobs.result_ref, where
 * markGatedProposal() stashes the ProposalPayload (+ proposal_type). Only
 * relevant when the job is gated/held (→ aggr 'needs-you').
 */
export function buildNeeds(
	jobRow: any,
	aggrStatus: AggrStatus
): { action: string; target: string } | undefined {
	if (aggrStatus !== 'needs-you') return undefined;

	let proposalType: string | undefined;
	let brief: string | undefined;
	if (jobRow?.result_ref) {
		try {
			const p = JSON.parse(jobRow.result_ref);
			proposalType = p.proposal_type;
			brief = (p.brief || p.task || '').toString();
		} catch {
			/* malformed result_ref — fall back to the job's brief below */
		}
	}
	const target = (brief || jobRow?.brief || 'this task').toString().slice(0, 200);
	const action = proposalType === 'routing_ask' ? 'Run this work separately?' : 'Run this task?';
	return { action, target };
}
