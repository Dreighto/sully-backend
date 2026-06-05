// Pure turn-decision classifier (Plan D, R1). No side effects — reads only.
// Mirrors maybeAutonomousDispatch's exact branch order so the two are always in sync.
import { getPendingProposal, type PendingProposal } from '$lib/server/dispatchJobs';
import { isAffirmation, isRoutingAnswer } from '$lib/server/routing/confirm';
import { decide } from '$lib/server/routing/decide';
import { validateGate } from '$lib/server/decisionGate';
import type { MutationGateResult } from '$lib/server/routing/mutation_gate';
import type { Tier } from '$lib/server/phase_classifier';

export type TurnDecision =
	| { kind: 'ROUTING_ANSWER'; answer: 'sibling' | 'defer'; proposal: PendingProposal }
	| { kind: 'RUNNING_WORK_INTENT'; activeTaskId: string | null }
	| { kind: 'CONVERSATIONAL_ONLY' }
	| { kind: 'CONFIRM_PROPOSAL'; proposal: PendingProposal }
	| { kind: 'DISPATCH'; worker: 'claude-code' | 'gemini'; category: string; brief: string }
	| { kind: 'PROPOSE'; worker: 'claude-code' | 'gemini'; category: string; brief: string }
	| { kind: 'ANSWER_NOW' };

export interface ResolveTurnDecisionArgs {
	userText: string;
	threadId: string;
	mutationGate?: MutationGateResult;
	tier?: Tier;
	/** CLI teacher self-assessment. Omitted pre-stream (deterministic). */
	gateBlock?: string | null;
}

/** Pure: classify the turn's outcome from pre-/post-stream state. No writes. */
export function resolveTurnDecision(args: ResolveTurnDecisionArgs): TurnDecision {
	const { userText, threadId } = args;
	const p = getPendingProposal(threadId);

	// A. routing-ask answer
	if (p?.proposalType === 'routing_ask') {
		const answer = isRoutingAnswer(userText);
		if (answer) return { kind: 'ROUTING_ANSWER', answer, proposal: p };
		// non-answer → fall through (apply-side expires it)
	}
	// B. mutation gate
	const gc = args.mutationGate?.classification;
	if (gc === 'RUNNING_WORK_INTENT')
		return {
			kind: 'RUNNING_WORK_INTENT',
			activeTaskId: args.mutationGate?.activeTaskId ?? null
		};
	if (gc === 'CONVERSATIONAL_ONLY') return { kind: 'CONVERSATIONAL_ONLY' };
	// C. pending dispatch proposal + affirmation
	if (p && p.proposalType !== 'routing_ask' && isAffirmation(userText))
		return { kind: 'CONFIRM_PROPOSAL', proposal: p };
	// D. intent gate
	const d = decide({ userText, fromTool: false, recentTier: args.tier, gateBlock: args.gateBlock });
	const gate = args.gateBlock !== undefined ? validateGate(args.gateBlock ?? null) : null;
	const category = gate && gate.ok ? gate.gate.category : 'code';
	const brief = gate && gate.ok ? gate.gate.brief : userText.slice(0, 200);
	const worker: 'claude-code' | 'gemini' =
		d.worker ?? (gate && gate.ok ? gate.gate.worker : 'claude-code');
	if (d.action === 'Dispatch') return { kind: 'DISPATCH', worker, category, brief };
	if (d.action === 'Ask') return { kind: 'PROPOSE', worker, category, brief };
	return { kind: 'ANSWER_NOW' };
}
