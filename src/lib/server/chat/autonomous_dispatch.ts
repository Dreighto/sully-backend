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
import { logTaskEvent, hasTaskEvent } from '$lib/server/chatActivity';
import { mintTaskId } from '$lib/server/chat_turn';
import {
	markSelfHandled,
	markGatedProposal,
	getPendingProposal,
	markAborted,
	getJob
} from '$lib/server/dispatchJobs';
import { captureGateBlock } from '$lib/server/routing/captureGate';
import { isAffirmation } from '$lib/server/routing/confirm';
import { env } from '$env/dynamic/private';
import type { Tier } from '$lib/server/phase_classifier';
import type { MutationGateResult } from '$lib/server/routing/mutation_gate';
import { resolveTurnDecision, type TurnDecision } from '$lib/server/routing/turn_decision';
import {
	DEFAULT_ROUTED_WORKER,
	resolveDispatchableWorker,
	workerLabel
} from '$lib/server/worker-registry';

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

// ── Role-dispatch derivation (LOS role-dispatch) ────────────────────────────
// The auto/default path (operator named no worker, gate named no worker → the
// resolved worker falls to DEFAULT_ROUTED_WORKER) routes by ROLE so the kernel
// rotates workers by role + trust, instead of always pinning claude-code. An
// explicit @worker (or a model-gate/teacher-named worker) still PINS that worker.
const FRONTEND_REPO_RE = /logueos-sully|sully-ios/i;
const FRONTEND_SIGNAL_RE =
	/swift|ios|swiftui|xcode|\.svelte|frontend|\bUI\b|component|screen|view|layout|mobile/i;

/** FRONTEND when the target is the iOS app repo or the task reads frontend; else BACKEND. */
function deriveRole(targetRepo: string, task: string): 'frontend' | 'backend' {
	if (FRONTEND_REPO_RE.test(targetRepo) || FRONTEND_SIGNAL_RE.test(task)) return 'frontend';
	return 'backend';
}

/** Pin when the operator explicitly named a dispatchable worker, OR the resolved
 *  worker is anything other than the routed default (i.e. a gate/model vote named
 *  one). Only the pure auto/default fallthrough → role-route. */
function shouldPinWorker(userText: string, worker: string): boolean {
	return resolveDispatchableWorker(userText) != null || worker !== DEFAULT_ROUTED_WORKER;
}

const ROLE_ROUTED_MSG = `On it — routing that to the best-fit worker now. I'll drop the answer right here when it's ready.`;

export interface ApplyTurnDecisionCtx {
	taskId: string;
	threadId: string;
	targetRepo: string;
	userText: string;
	/** When true, suppress the assistant-side chat row each branch normally
	 *  writes (the templated "That looks like a job for X" / "On it" string).
	 *  Voice-reply Part A (2026-06-28) needs the gate-marking + dispatch
	 *  bookkeeping side effects but generates its own natural reply via
	 *  companion-v1-voice; persisting the template polluted history and made
	 *  the next turn echo the template's style. */
	suppressSpokenChatRow?: boolean;
	/**
	 * Stage 2 residual: true when this turn REUSED a pre-existing operator row +
	 * Task (a keyed retry / regenerate / reconnect re-POST). Such a turn already
	 * ran its dispatch decision on the first attempt, so re-running it here would
	 * fire a SECOND dispatch + a second "Dispatch held" system message for the
	 * same task (chat_messages 2134/2135, 4s apart, one pending_jobs row). The
	 * guard below skips the re-decision when the task already decided. Absent /
	 * false for a fresh turn (the common case) — no behavior change there.
	 */
	reused?: boolean;
}

/**
 * Idempotency probe for the Stage 2 reuse guard: has this task already had its
 * dispatch decision applied? True if any applyTurnDecision arm already journaled
 * a `gate_evaluated` event, OR the pending_jobs row has advanced past the
 * pre-decision states (proposed/classified) — either way a prior turn acted on
 * it. A reused turn that was interrupted BEFORE its decision (no gate event, row
 * still proposed/classified) returns false, so it still dispatches.
 */
function taskAlreadyDecided(taskId: string): boolean {
	if (hasTaskEvent(taskId, 'gate_evaluated')) return true;
	const job = getJob(taskId);
	return !!job && job.status !== 'proposed' && job.status !== 'classified';
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
	// Stage 2 reuse guard: a keyed retry/regenerate/reconnect re-POST reuses the
	// original operator row + Task and re-runs the stream, reaching here a SECOND
	// time for a task whose decision already fired. Skip the re-decision (and the
	// duplicate dispatch / "Dispatch held" system message) when this task already
	// decided. Scoped to reused turns so a fresh turn never pays the DB probe; an
	// interrupted-before-decision retry (reused but not yet decided) still runs.
	if (ctx.reused && taskAlreadyDecided(taskId)) return {};
	// Voice-reply opts out of templated spoken chat rows — companion-v1-voice
	// will generate the spoken reply naturally and those template rows in
	// history bias the next turn toward AI-chatbot phrasing. Keep all OTHER
	// side effects (gate marks, dispatch calls, journal events).
	const writeSpokenRow = !ctx.suppressSpokenChatRow;
	// When the chat row is suppressed, also DROP the returned spokenSuffix.
	// The caller (voice-reply) currently emits any non-empty spokenSuffix as
	// a `suffix` SSE event; iOS appends it to captions; result was the
	// templated "That looks like a job for CC — ..." string typing onto the
	// voice mode screen at end-of-reply with NO audio (b104 regression
	// observed in the operator's 2026-06-28 recording at 2:11). Same flag
	// gates both the row write and the return value so the templated string
	// can never reach the surface.
	const sup = (s: string) => (ctx.suppressSpokenChatRow ? '' : s);

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
					threadId,
					role: pendingRoutingAsk.role,
					pinWorker: pendingRoutingAsk.pinWorker
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
				if (writeSpokenRow) {
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
				}
				markAborted(pendingRoutingAsk.taskId);
				markSelfHandled(taskId);
				return { spokenSuffix: sup(msg) };
			}
			// defer
			markAborted(pendingRoutingAsk.taskId);
			const msg = `Okay — I'll hold that until the current task finishes.`;
			if (writeSpokenRow) {
				addChatMessage('local', msg, null, null, null, 'sent', threadId, {
					taskId: pendingRoutingAsk.taskId
				});
			}
			logTaskEvent(pendingRoutingAsk.taskId, 'gate_evaluated', {
				action: 'Defer',
				reason: 'routing-ask: defer',
				deferred_content: pendingRoutingAsk.task
			});
			markSelfHandled(taskId);
			return { spokenSuffix: sup(msg) };
		}

		case 'RUNNING_WORK_INTENT': {
			const { activeTaskId } = decision;
			// Honor a worker the operator named in the held request; otherwise the
			// registry's single routed default (never a local literal). When neither
			// named one, role-route so the kernel rotates when this held work runs.
			const heldWorker = resolveDispatchableWorker(userText) ?? DEFAULT_ROUTED_WORKER;
			const heldPin = shouldPinWorker(userText, heldWorker);
			markGatedProposal(
				taskId,
				{
					worker: heldWorker,
					category: 'code',
					brief: userText.slice(0, 200),
					targetRepo,
					task: userText,
					role: heldPin ? undefined : deriveRole(targetRepo, userText),
					pinWorker: heldPin
				},
				'routing_ask'
			);
			const ask = `I've got a task running. Want me to hold this until it finishes, or run it as a separate task? Just tell me 'hold it' or 'run it separately'.`;
			if (writeSpokenRow) {
				addChatMessage('local', ask, activeTaskId, null, null, 'sent', threadId, {
					taskId
				});
			}
			logTaskEvent(taskId, 'gate_evaluated', {
				action: 'RoutingAsk',
				reason: 'running-task work-intent — held, not injected',
				activeTaskId
			});
			return { spokenSuffix: sup(ask) };
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
				threadId,
				role: pending.role,
				pinWorker: pending.pinWorker
			});
			logTaskEvent(pending.taskId, 'gate_evaluated', {
				action: 'Dispatch',
				reason: 'operator-confirmed',
				worker: pending.worker,
				dispatched: res.ok,
				held_reason: res.ok ? null : res.reason
			});
			// Role-routed (pinWorker === false): don't name a worker — LOS-191 names
			// the actual worker later. Legacy/pinned proposals keep naming the worker.
			const msg = res.ok
				? pending.pinWorker === false
					? ROLE_ROUTED_MSG
					: `On it — handing that to ${workerLabel(pending.worker)} now. I'll drop the answer right here when it's ready.`
				: `⚠️ Dispatch held: ${res.reason}.`;
			if (writeSpokenRow)
				addChatMessage(
					'system',
					msg,
					res.ok ? pending.taskId : null,
					null,
					null,
					'sent',
					threadId,
					{
						taskId: pending.taskId
					}
				);
			if (!res.ok) markSelfHandled(pending.taskId);
			markSelfHandled(taskId);
			return { spokenSuffix: sup(msg) };
		}

		case 'DISPATCH': {
			const { worker, category, brief } = decision;
			// DISPATCH fires on an explicit @worker rule-mention, so this normally
			// pins. Compute defensively anyway: if a future gate ever routes DISPATCH
			// to the bare default with no named worker, role-route it.
			const pin = shouldPinWorker(userText, worker);
			const res = await dispatchToWorker({
				traceId: taskId,
				worker,
				category,
				brief,
				targetRepo,
				task: userText,
				threadId,
				role: pin ? undefined : deriveRole(targetRepo, userText),
				pinWorker: pin
			});
			logTaskEvent(taskId, 'gate_evaluated', {
				action: 'Dispatch',
				reason: decision.reason,
				worker,
				category,
				dispatched: res.ok,
				held_reason: res.ok ? null : res.reason
			});
			// Correct attribution (LOS-191): the reply names the worker actually
			// dispatched ("DPSK is on it"), never a hardcoded persona. Role-routed
			// dispatches stay soft — the actual worker is named later via LOS-191.
			const msg = res.ok
				? pin
					? `${workerLabel(worker)} is on it — I'll drop the answer right here the moment it's ready.`
					: ROLE_ROUTED_MSG
				: `⚠️ Dispatch held: ${res.reason}.`;
			if (writeSpokenRow)
				addChatMessage('system', msg, res.ok ? taskId : null, null, null, 'sent', threadId, {
					taskId
				});
			if (!res.ok) markSelfHandled(taskId);
			return { spokenSuffix: sup(msg) };
		}

		case 'PROPOSE': {
			const { worker, category, brief } = decision;
			// Persist role + pinWorker on the proposal so the later confirm turn can
			// role-route (auto path) or pin (explicit @worker). No schema change —
			// they ride in the result_ref JSON via markGatedProposal.
			const pin = shouldPinWorker(userText, worker);
			markGatedProposal(taskId, {
				worker,
				category,
				brief,
				targetRepo,
				task: userText,
				role: pin ? undefined : deriveRole(targetRepo, userText),
				pinWorker: pin
			});
			const ask = pin
				? `That looks like a job for ${workerLabel(worker)} — "${brief}". Want me to run it? Tap below, or just say "yes".`
				: `That looks like a job I can hand off — "${brief}". Want me to run it? I'll route it to the best-fit worker. Tap below, or just say "yes".`;
			if (writeSpokenRow) {
				addChatMessage('local', ask, taskId, null, null, 'pending_approval', threadId, {
					taskId
				});
			}
			logTaskEvent(taskId, 'gate_evaluated', {
				action: 'Ask',
				reason: decision.reason,
				worker,
				dispatched: false
			});
			return { spokenSuffix: sup(ask) };
		}

		case 'REJECT_WORKER': {
			// Operator named a non-dispatchable roster member — graceful, deterministic
			// rejection with the registry's copy. No silent substitution (LOS-191).
			if (writeSpokenRow) {
				addChatMessage('local', decision.message, null, null, null, 'sent', threadId, { taskId });
			}
			logTaskEvent(taskId, 'gate_evaluated', {
				action: 'Reject',
				reason: `non-dispatchable:${decision.name}`,
				dispatched: false
			});
			markSelfHandled(taskId);
			return { spokenSuffix: sup(decision.message) };
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
