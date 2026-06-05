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

import { addChatMessage } from '$lib/server/chat';
import { runMode } from '$lib/server/config';
import { dispatchToWorker } from '$lib/server/companionDispatch';
import { logTaskEvent } from '$lib/server/chatActivity';
import { mintTaskId } from '$lib/server/chat_turn';
import {
	markSelfHandled,
	markGatedProposal,
	getPendingProposal,
	markAborted
} from '$lib/server/dispatchJobs';
import { captureGateBlock } from '$lib/server/routing/captureGate';
import { isAffirmation } from '$lib/server/routing/confirm';
import { env } from '$env/dynamic/private';
import type { Tier } from '$lib/server/phase_classifier';
import type { MutationGateResult } from '$lib/server/routing/mutation_gate';
import { resolveTurnDecision, type TurnDecision } from '$lib/server/routing/turn_decision';

/** Operator-facing worker label. */
const workerLabel = (w: 'claude-code' | 'gemini'): string => (w === 'gemini' ? 'AGY' : 'CC');

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

export interface ApplyTurnDecisionCtx {
	taskId: string;
	threadId: string;
	targetRepo: string;
	userText: string;
}

/**
 * Execute the side effects for a turn decision: chat messages, journal events,
 * dispatch calls, job-state transitions. Exactly mirrors the old bodies of
 * maybeAutonomousDispatch — one arm per TurnDecision kind.
 */
export async function applyTurnDecision(
	decision: TurnDecision,
	ctx: ApplyTurnDecisionCtx
): Promise<{ spokenSuffix?: string }> {
	const { taskId, threadId, targetRepo, userText } = ctx;

	switch (decision.kind) {
		case 'ROUTING_ANSWER': {
			const { answer, proposal: pendingRoutingAsk } = decision;
			if (answer === 'sibling') {
				const siblingTraceId = mintTaskId();
				const res = await dispatchToWorker({
					traceId: siblingTraceId,
					worker: pendingRoutingAsk.worker,
					category: pendingRoutingAsk.category,
					brief: pendingRoutingAsk.brief,
					targetRepo: pendingRoutingAsk.targetRepo,
					task: pendingRoutingAsk.task,
					threadId
				});
				logTaskEvent(pendingRoutingAsk.taskId, 'gate_evaluated', {
					action: 'Dispatch',
					reason: 'routing-ask: sibling',
					worker: pendingRoutingAsk.worker,
					dispatched: res.ok,
					held_reason: res.ok ? null : res.reason
				});
				const msg = res.ok
					? `On it — running that as a separate task. I'll drop the result right here when it's ready.`
					: `Could not start a new task: ${res.reason}.`;
				addChatMessage(
					'system',
					msg,
					res.ok ? siblingTraceId : null,
					null,
					null,
					'sent',
					threadId,
					{
						taskId: pendingRoutingAsk.taskId
					}
				);
				markAborted(pendingRoutingAsk.taskId);
				markSelfHandled(taskId);
				return { spokenSuffix: msg };
			}
			// defer
			markAborted(pendingRoutingAsk.taskId);
			const msg = `Okay — I'll hold that until the current task finishes.`;
			addChatMessage('local', msg, null, null, null, 'sent', threadId, {
				taskId: pendingRoutingAsk.taskId
			});
			logTaskEvent(pendingRoutingAsk.taskId, 'gate_evaluated', {
				action: 'Defer',
				reason: 'routing-ask: defer',
				deferred_content: pendingRoutingAsk.task
			});
			markSelfHandled(taskId);
			return { spokenSuffix: msg };
		}

		case 'RUNNING_WORK_INTENT': {
			const { activeTaskId } = decision;
			markGatedProposal(
				taskId,
				{
					worker: 'claude-code',
					category: 'code',
					brief: userText.slice(0, 200),
					targetRepo,
					task: userText
				},
				'routing_ask'
			);
			const ask = `I've got a task running. Want me to hold this until it finishes, or run it as a separate task? Just tell me 'hold it' or 'run it separately'.`;
			addChatMessage('local', ask, activeTaskId, null, null, 'sent', threadId, {
				taskId
			});
			logTaskEvent(taskId, 'gate_evaluated', {
				action: 'RoutingAsk',
				reason: 'running-task work-intent — held, not injected',
				activeTaskId
			});
			return { spokenSuffix: ask };
		}

		case 'CONVERSATIONAL_ONLY': {
			logTaskEvent(taskId, 'gate_evaluated', {
				action: 'Talk',
				reason: 'conversational-only during running task',
				dispatched: false
			});
			markSelfHandled(taskId);
			return {};
		}

		case 'CONFIRM_PROPOSAL': {
			const { proposal: pending } = decision;
			const res = await dispatchToWorker({
				traceId: pending.taskId,
				worker: pending.worker,
				category: pending.category,
				brief: pending.brief,
				targetRepo: pending.targetRepo,
				task: pending.task,
				threadId
			});
			logTaskEvent(pending.taskId, 'gate_evaluated', {
				action: 'Dispatch',
				reason: 'operator-confirmed',
				worker: pending.worker,
				dispatched: res.ok,
				held_reason: res.ok ? null : res.reason
			});
			const msg = res.ok
				? `On it — handing that to ${workerLabel(pending.worker)} now. I'll drop the answer right here when it's ready.`
				: `⚠️ Dispatch held: ${res.reason}.`;
			addChatMessage('system', msg, res.ok ? pending.taskId : null, null, null, 'sent', threadId, {
				taskId: pending.taskId
			});
			if (!res.ok) markSelfHandled(pending.taskId);
			markSelfHandled(taskId);
			return { spokenSuffix: msg };
		}

		case 'DISPATCH': {
			const { worker, category, brief } = decision;
			const res = await dispatchToWorker({
				traceId: taskId,
				worker,
				category,
				brief,
				targetRepo,
				task: userText,
				threadId
			});
			logTaskEvent(taskId, 'gate_evaluated', {
				action: 'Dispatch',
				reason: decision.reason,
				worker,
				category,
				dispatched: res.ok,
				held_reason: res.ok ? null : res.reason
			});
			const msg = res.ok
				? `On it — this one needs some real digging, so give me a few minutes. I'll drop the answer right here the moment it's ready.`
				: `⚠️ Dispatch held: ${res.reason}.`;
			addChatMessage('system', msg, res.ok ? taskId : null, null, null, 'sent', threadId, {
				taskId
			});
			if (!res.ok) markSelfHandled(taskId);
			return { spokenSuffix: msg };
		}

		case 'PROPOSE': {
			const { worker, category, brief } = decision;
			markGatedProposal(taskId, { worker, category, brief, targetRepo, task: userText });
			const ask = `That looks like a job for ${workerLabel(worker)} — "${brief}". Want me to run it? Tap below, or just say "yes".`;
			addChatMessage('local', ask, taskId, null, null, 'pending_approval', threadId, { taskId });
			logTaskEvent(taskId, 'gate_evaluated', {
				action: 'Ask',
				reason: decision.reason,
				worker,
				dispatched: false
			});
			return { spokenSuffix: ask };
		}

		case 'ANSWER_NOW': {
			logTaskEvent(taskId, 'gate_evaluated', {
				action: 'Talk',
				reason: decision.reason,
				dispatched: false
			});
			markSelfHandled(taskId);
			return {};
		}
	}
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

	const { userText, targetRepo, threadId } = args;
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
