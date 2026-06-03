// The single, pure routing decision for a turn. Replaces the inlined CLI-vs-
// direct branches in autonomous_dispatch.ts so the decision is one testable +
// scoreable unit, and so the scorecard tests EXACTLY what production runs.
//
// Returns the 3-class action. NOTE: this extraction is behavior-preserving for
// today's runtime — 'Ask' is mapped by the caller to "do not fire" (the same as
// 'Talk') until the Ask-behavior is built in Phase 2. The scorecard grades
// against Talk/Ask/Dispatch regardless, which is what surfaces the gap.
import { ruleGate, valueGate, validateGate } from '../decisionGate';
import type { Tier } from '../phase_classifier';

export type RouteAction = 'Talk' | 'Ask' | 'Dispatch';

export interface DecideInput {
	userText: string;
	fromTool: boolean;
	/** The thread's classified tier this turn (chat/planning/deep/local). */
	recentTier?: Tier;
	/** The teacher's SULLY_GATE self-assessment block (CLI path only). `undefined`
	 *  = no model vote available (direct/local path). */
	gateBlock?: string | null;
}

export interface RouteDecision {
	action: RouteAction;
	worker?: 'claude-code' | 'gemini';
	reason: string;
}

export function decide(input: DecideInput): RouteDecision {
	const { userText, fromTool, gateBlock } = input;

	const vg = valueGate({ text: userText, fromTool });

	// 1. Injection guard FIRST: tool-sourced / pasted content must NEVER auto-fire,
	//    even when it contains an @cc/@agy mention (a pasted doc could smuggle one).
	//    A qualifying tool turn becomes Ask (confirm with the operator); pure
	//    pasted chatter is just Talk. This precedes ruleGate by design.
	if (fromTool) {
		return vg.qualifies
			? { action: 'Ask', reason: 'tool-sourced' }
			: { action: 'Talk', reason: vg.reason };
	}

	// 2. Explicit @cc/@agy mention from the operator forces a dispatch, any tier.
	const forced = ruleGate(userText);
	if (forced.forced && forced.worker) {
		return { action: 'Dispatch', worker: forced.worker, reason: 'rule:mention' };
	}

	// 3. Deterministic objective-signal gate.
	if (!vg.qualifies) return { action: 'Talk', reason: vg.reason };

	// 3b. Safe fix A: never AUTONOMOUSLY fire mid-brainstorm. A qualifying request
	//     while the thread is in planning/deep is likely "talking about it", not a
	//     work order — surface it as Ask (Phase 2 turns this into a real prompt;
	//     today the caller maps Ask → do-not-fire). @cc already short-circuited above.
	if (input.recentTier === 'planning' || input.recentTier === 'deep') {
		return { action: 'Ask', reason: 'qualifies-but-brainstorm-tier' };
	}

	// 4. Model-vote layer (CLI path only). When a gate block is present it MUST
	//    validate + escalate; otherwise the qualifying turn is talked, not fired.
	if (gateBlock !== undefined) {
		const gate = validateGate(gateBlock ?? null);
		if (!(gate.ok && gate.gate.escalate)) {
			return { action: 'Talk', reason: 'model-vote-no-escalate' };
		}
		return { action: 'Dispatch', worker: gate.gate.worker, reason: 'qualifies+model-vote' };
	}

	// 5. Direct/local path — deterministic qualification alone decides.
	return { action: 'Dispatch', worker: 'claude-code', reason: 'qualifies' };
}
