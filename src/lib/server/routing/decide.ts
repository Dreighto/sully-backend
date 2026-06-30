// The single, pure routing decision for a turn. Replaces the inlined CLI-vs-
// direct branches in autonomous_dispatch.ts so the decision is one testable +
// scoreable unit, and so the scorecard tests EXACTLY what production runs.
//
// Returns the 3-class action. NOTE: this extraction is behavior-preserving for
// today's runtime — 'Ask' is mapped by the caller to "do not fire" (the same as
// 'Talk') until the Ask-behavior is built in Phase 2. The scorecard grades
// against Talk/Ask/Dispatch regardless, which is what surfaces the gap.
import { ruleGate, valueGate, validateGate } from '../decisionGate';
import { DEFAULT_ROUTED_WORKER, type WorkerName } from '../worker-registry';
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
	worker?: WorkerName;
	reason: string;
	/** Set (with action 'Talk') when the operator named a non-dispatchable
	 *  roster member — carries the graceful rejection copy to surface. */
	rejection?: { name: string; label: string; copy: string };
}

// A request to produce code/a command (write/show/give a function, script,
// snippet, one-liner, command, regex, query, example).
const CODE_GEN_RE =
	/\b(write|show|give|gen(?:erate)?|create|make|build|code|need|want)\b[\s\S]{0,50}\b(function|method|script|snippet|one[\s-]?liner|command|regex|query|loop|class|component|cli|code|example)\b|\bhow (?:do|to|can) (?:i|you|we)\b[\s\S]{0,50}\b(?:write|code|script|function|command|reverse|sort|parse|format|convert)\b/i;

// Repo/app-scoped work that genuinely wants a worker (touches real files, the
// codebase, a ticket, a deploy, a fix/refactor/implement of existing things).
const REPO_SIGNAL_RE =
	/\b(?:the (?:codebase|repo(?:sitory)?|project|app|build|component|module|backend|frontend)|in [\w./-]+\.(?:swift|ts|tsx|js|jsx|py|go|rs|java|json|ya?ml|sh|svelte|css|html)|fix (?:the|this|a|that)|refactor|implement (?:the|a|this)|debug (?:the|this)|our (?:code|app|repo|backend|frontend)|the existing|deploy|wire (?:up|it|this|in)|[A-Z]{2,4}-\d{1,5})\b/i;

/** Small self-contained code/command request that Sully should answer inline,
 *  not dispatch: a code-gen ask with no repo/app/file signal. */
function isInlineCodeRequest(text: string): boolean {
	return CODE_GEN_RE.test(text) && !REPO_SIGNAL_RE.test(text);
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
			? { action: 'Ask', worker: DEFAULT_ROUTED_WORKER, reason: 'tool-sourced' }
			: { action: 'Talk', reason: vg.reason };
	}

	// 2. An explicitly named roster worker from the operator is a direct command
	//    — the ONLY path that dispatches immediately, no confirmation needed.
	//    Naming a non-dispatchable member (CUR/Hermes) is rejected gracefully
	//    instead of silently substituting a default (LOS-191).
	const forced = ruleGate(userText);
	if (forced.rejection) {
		return {
			action: 'Talk',
			reason: `non-dispatchable:${forced.rejection.name}`,
			rejection: forced.rejection
		};
	}
	if (forced.forced && forced.worker) {
		return { action: 'Dispatch', worker: forced.worker, reason: 'rule:mention' };
	}

	// 3. Deterministic objective-signal gate.
	if (!vg.qualifies) return { action: 'Talk', reason: vg.reason };

	// 3b. Operator pref: a small self-contained code/command request (a snippet, a
	//     function, a one-liner, a command) is something Sully writes inline. Only
	//     code work scoped to the actual repo/app/files dispatches to a worker. An
	//     explicit @cc/@agy above still forces a dispatch.
	if (isInlineCodeRequest(userText)) {
		return { action: 'Talk', reason: 'inline-code-snippet' };
	}

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

	// 5. Qualifying work intent without an explicitly named worker → PROPOSE
	//    (ask first), never auto-dispatch. The operator confirms with a natural
	//    "yes". The registry's single routed default — never a scattered literal.
	return { action: 'Ask', worker: DEFAULT_ROUTED_WORKER, reason: 'work-intent' };
}
