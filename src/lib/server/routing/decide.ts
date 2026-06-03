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
			? { action: 'Ask', worker: 'claude-code', reason: 'tool-sourced' }
			: { action: 'Talk', reason: vg.reason };
	}

	// 2. Explicit @cc/@agy mention from the operator is a direct command — the
	//    ONLY path that dispatches immediately, no confirmation needed.
	const forced = ruleGate(userText);
	if (forced.forced && forced.worker) {
		return { action: 'Dispatch', worker: forced.worker, reason: 'rule:mention' };
	}

	// 3. Deterministic objective-signal gate.
	if (!vg.qualifies) return { action: 'Talk', reason: vg.reason };

	// 4. Model-vote layer (CLI path only). A gate block that does NOT escalate is
	//    the teacher saying "not real work" → Talk. (Tier no longer gates the
	//    Ask/Dispatch choice — under ask-before-dispatch EVERY qualifying turn
	//    that isn't an explicit @mention is PROPOSED, never auto-fired.)
	if (gateBlock !== undefined) {
		const gate = validateGate(gateBlock ?? null);
		if (!(gate.ok && gate.gate.escalate)) {
			return { action: 'Talk', reason: 'model-vote-no-escalate' };
		}
		return { action: 'Ask', worker: gate.gate.worker, reason: 'work-intent+model-vote' };
	}

	// 5. Qualifying work intent without an explicit @mention → PROPOSE (ask first),
	//    never auto-dispatch. The operator confirms with a natural "yes".
	return { action: 'Ask', worker: 'claude-code', reason: 'work-intent' };
}
