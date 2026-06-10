// Pure turn-decision classifier (Plan D, R1). No side effects — reads only.
// Mirrors maybeAutonomousDispatch's exact branch order so the two are always in sync.
import { getPendingProposal, type PendingProposal } from '$lib/server/dispatchJobs';
import { isAffirmation, isRoutingAnswer } from '$lib/server/routing/confirm';
import { decide } from '$lib/server/routing/decide';
import { validateGate } from '$lib/server/decisionGate';
import { DEFAULT_ROUTED_WORKER, type WorkerName } from '$lib/server/worker-registry';
import type { MutationGateResult } from '$lib/server/routing/mutation_gate';
import type { Tier } from '$lib/server/phase_classifier';

export type TurnDecision =
	| { kind: 'ROUTING_ANSWER'; answer: 'sibling' | 'defer'; proposal: PendingProposal }
	| { kind: 'RUNNING_WORK_INTENT'; activeTaskId: string | null }
	| { kind: 'CONVERSATIONAL_ONLY' }
	| { kind: 'ANSWER_NOW'; reason: string }
	| { kind: 'CONFIRM_PROPOSAL'; proposal: PendingProposal }
	// Operator named a non-dispatchable roster member (CUR/Hermes) — surface the
	// registry's rejection copy deterministically, no model generation (LOS-191).
	| { kind: 'REJECT_WORKER'; name: string; message: string }
	| {
			kind: 'DISPATCH';
			worker: WorkerName;
			category: string;
			brief: string;
			reason: string;
	  }
	| {
			kind: 'PROPOSE';
			worker: WorkerName;
			category: string;
			brief: string;
			reason: string;
	  };

export interface ResolveTurnDecisionArgs {
	userText: string;
	threadId: string;
	mutationGate?: MutationGateResult;
	tier?: Tier;
	/** CLI teacher self-assessment. Omitted pre-stream (deterministic). */
	gateBlock?: string | null;
}

/** True when the turn should generate a full conversational reply (pure chat,
 *  or chat while a task runs). All other decisions short-circuit to a short
 *  status/proposal with no model generation. */
export function needsFullReply(decision: TurnDecision): boolean {
	return decision.kind === 'ANSWER_NOW' || decision.kind === 'CONVERSATIONAL_ONLY';
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
	// C. pending proposal + affirmation → confirm. Includes a routing_ask: the
	// original maybeAutonomousDispatch treated "yes" to ANY pending proposal as a
	// confirm (dispatch its held content). Excluding routing_ask here would leave
	// the held work gated → silently aborted next turn, violating "never silently
	// dropped". Routing ANSWERS ("hold it"/"run it separately") are already taken
	// by branch A above, so this only catches an off-script affirmation.
	if (p && isAffirmation(userText)) return { kind: 'CONFIRM_PROPOSAL', proposal: p };
	// D. intent gate
	const d = decide({ userText, fromTool: false, recentTier: args.tier, gateBlock: args.gateBlock });
	if (d.rejection) {
		return { kind: 'REJECT_WORKER', name: d.rejection.name, message: d.rejection.copy };
	}
	const gate = args.gateBlock !== undefined ? validateGate(args.gateBlock ?? null) : null;
	const category = gate && gate.ok ? gate.gate.category : 'code';
	const brief = gate && gate.ok ? gate.gate.brief : userText.slice(0, 200);
	const worker: WorkerName =
		d.worker ?? (gate && gate.ok ? gate.gate.worker : DEFAULT_ROUTED_WORKER);
	// Preserve decide()'s exact reason so the gate_evaluated journal payload is
	// byte-identical to the pre-D1 flow (CLI path emits 'work-intent+model-vote',
	// direct/local 'work-intent'; Dispatch always 'rule:mention').
	if (d.action === 'Dispatch')
		return { kind: 'DISPATCH', worker, category, brief, reason: d.reason };
	if (d.action === 'Ask') return { kind: 'PROPOSE', worker, category, brief, reason: d.reason };
	return { kind: 'ANSWER_NOW', reason: d.reason };
}
