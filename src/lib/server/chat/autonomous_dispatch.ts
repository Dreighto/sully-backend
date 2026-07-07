// Autonomous dispatch (spec §4.2) — shared by BOTH streaming paths in
// src/routes/api/chat/sdk-stream/+server.ts.
//
// After producing a reply, the route decides whether to hand the operator's
// request off to a coding worker (CC / AGY) in the background. The two paths
// reach this decision slightly differently:
//
//   CLI-bridge path (Sonnet/Opus): the teacher (Opus) appends a hidden
//     <<<SULLY_GATE {...}>>> self-assessment block to its reply. The route
//     extracts that block and passes it here as `gateBlock`. The escalate
//     decision then ALSO requires the gate to validate + say escalate:true,
//     AND the deterministic valueGate to qualify.
//
//   Direct/local path (Haiku/Gemini/Ollama): streamText output can't be
//     cleanly stripped of a gate block, so there is NO gate block. `gateBlock`
//     is omitted and the deterministic gates alone decide: ruleGate (@cc/@agy
//     override) + valueGate (file/code/repo/long-imperative signals).
//
// In BOTH cases ruleGate (@cc/@agy literal mention) forces a dispatch. The
// worker/brief/category derivation differs: with a valid gate block the route
// prefers the teacher's choices; without one it falls back to claude-code /
// userText-slice / 'code'. This helper unifies the dispatchToWorker call + the
// system "sent to worker" message write while preserving each path's exact
// escalate condition and worker/brief/category derivation.
//
// Wave 3 split (2026-07-06): role-routing helpers moved to
// ./dispatch_role_routing.ts, and the per-decision side-effect switch moved to
// ./turn_decision_apply.ts. applyTurnDecision is re-exported here (unchanged
// import path) since it's imported directly by all 4 sdk-reply handlers.

import { describeAttachmentsForClassifier } from '$lib/server/chat/attachment_inline';
import { runMode } from '$lib/server/config';
import { mintTaskId } from '$lib/server/chat_turn';
import { markAborted, getPendingProposal } from '$lib/server/dispatchJobs';
import { captureGateBlock } from '$lib/server/routing/captureGate';
import { isAffirmation } from '$lib/server/routing/confirm';
import { env } from '$env/dynamic/private';
import type { Tier } from '$lib/server/phase_classifier';
import type { MutationGateResult } from '$lib/server/routing/mutation_gate';
import { resolveTurnDecision } from '$lib/server/routing/turn_decision';
import { applyTurnDecision } from './turn_decision_apply';

export { applyTurnDecision, type ApplyTurnDecisionCtx } from './turn_decision_apply';

export interface AutonomousDispatchArgs {
	/** The latest user message text (space-joined, trimmed). */
	userText: string;
	targetRepo: string;
	threadId: string;
	/**
	 * The pre-extracted SULLY_GATE self-assessment block, if any. Present only
	 * on the CLI-bridge path. When provided, it is validated and its
	 * escalate/worker/brief/category steer the decision; when omitted (direct/
	 * local path), the deterministic gates alone decide.
	 */
	gateBlock?: string | null;
	/**
	 * The Task id minted in prepareStream for this turn. When present, the
	 * dispatched job + the system "sent to worker" message reuse it (instead of
	 * minting a fresh sully-* id), so the whole turn — operator row, reply,
	 * dispatch, journal — shares one handle. The 'proposed' Task row created at
	 * turn start gets promoted to 'decided' by the dispatch. Falls back to a
	 * minted id if absent (legacy callers).
	 */
	taskId?: string;
	/** The thread's classified tier this turn — gates brainstorm suppression. */
	tier?: Tier;
	/**
	 * Result of the Mutation Gate (R2). Passed from prepareTurnLifecycle via
	 * PreparedStreamContext. When present and classification is RUNNING_WORK_INTENT
	 * or CONVERSATIONAL_ONLY, the gate short-circuits before the normal flow.
	 * Optional for backwards-compat with callers that predate R2 (tests, etc.).
	 */
	mutationGate?: MutationGateResult;
}

/**
 * Evaluate the autonomous-dispatch gates and, if they fire, hand the request
 * to a background worker + write the system "sent to worker" chat message.
 *
 * No-op when companion dispatch is disabled — matches both paths' top-level
 * `runMode.companionDispatchEnabled` guard. The CLI path additionally gates on
 * `!errored` BEFORE calling this (a half/failed gen should never dispatch).
 */
export async function maybeAutonomousDispatch(
	args: AutonomousDispatchArgs
): Promise<{ spokenSuffix?: string }> {
	if (!runMode.companionDispatchEnabled) return {};

	const { userText: rawUserText, targetRepo, threadId } = args;
	// Attachment hygiene: the classifier reads plain-English mentions, never
	// raw upload-link markdown; an attachment-only turn ("here's a file") is
	// context, not a dispatchable brief — never propose work for it.
	const { cleaned: userText, attachmentOnly } = describeAttachmentsForClassifier(rawUserText);
	if (attachmentOnly) return {};
	// Reuse the turn's Task id so the dispatch promotes the existing 'proposed'
	// row rather than creating an orphan. Fall back to a minted id for legacy
	// callers that don't pass one.
	const taskId = args.taskId ?? mintTaskId();

	// Defensive stale-proposal expiry: if there is a non-routing pending proposal
	// AND this turn is NOT an affirmation, expire it now. This must happen BEFORE
	// resolveTurnDecision reads the proposal so that a stale non-affirmed proposal
	// cannot be seen as a CONFIRM_PROPOSAL by the pure classifier.
	// (The routing_ask case is handled inside applyTurnDecision — its proposal is
	// consumed via markAborted in the ROUTING_ANSWER arms, not here.)
	const pending = getPendingProposal(threadId);
	if (pending && pending.proposalType !== 'routing_ask' && !isAffirmation(userText)) {
		markAborted(pending.taskId);
	}

	const decision = resolveTurnDecision({
		userText,
		threadId,
		mutationGate: args.mutationGate,
		tier: args.tier,
		gateBlock: args.gateBlock
	});

	// Capture the teacher's model-vote block (CLI path) for OFFLINE scoring of the
	// SULLY_GATE layer — ONLY on decide()-reaching outcomes, matching the pre-D1
	// placement (after the routing-ask / mutation-gate / confirm early returns) so
	// the capture dataset is unchanged. Free, env-gated, best-effort — off by default.
	if (
		(decision.kind === 'DISPATCH' ||
			decision.kind === 'PROPOSE' ||
			decision.kind === 'ANSWER_NOW') &&
		args.gateBlock !== undefined &&
		env.ROUTING_CAPTURE_GATES === '1'
	) {
		captureGateBlock({ userText, gateBlock: args.gateBlock ?? null, tier: args.tier });
	}

	return applyTurnDecision(decision, { taskId, threadId, targetRepo, userText });
}
