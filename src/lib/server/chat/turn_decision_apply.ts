import { addChatMessage } from '$lib/server/chat';
import { dispatchToWorker } from '$lib/server/companionDispatch';
import { logTaskEvent, hasTaskEvent } from '$lib/server/chatActivity';
import { mintTaskId } from '$lib/server/chat_turn';
import { markSelfHandled, markGatedProposal, markAborted, getJob } from '$lib/server/dispatchJobs';
import type { TurnDecision } from '$lib/server/routing/turn_decision';
import {
	DEFAULT_ROUTED_WORKER,
	resolveDispatchableWorker,
	workerLabel
} from '$lib/server/worker-registry';
import {
	deriveRole,
	shouldPinWorker,
	ROLE_ROUTED_MSG,
	codeOnlyWorkerCantRun,
	isSelfServeSpeedTask
} from './dispatch_role_routing';

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
			// Lock + inform (operator 2026-07-08): a code-only worker explicitly
			// named for a shell / live-system task can't run it — it only edits
			// code, so it ghosts. Don't dispatch it to fail; tell him plainly and
			// point at the capable path (Sully self-serves a speed test; CC for the
			// heavier shell work).
			if (pin && codeOnlyWorkerCantRun(worker, userText)) {
				const label = workerLabel(worker);
				const alt = isSelfServeSpeedTask(userText)
					? "That's a light one I can just run myself — want me to?"
					: 'CC can handle it — want me to send CC instead?';
				const msg = `${label} can't run that — it only edits code, no shell, so it'd come back empty. ${alt}`;
				if (writeSpokenRow)
					addChatMessage('system', msg, null, null, null, 'sent', threadId, { taskId });
				logTaskEvent(taskId, 'gate_evaluated', {
					action: 'DispatchLocked',
					reason: 'worker_task_mismatch',
					worker,
					category,
					dispatched: false,
					held_reason: 'worker_cannot_run_task'
				});
				markSelfHandled(taskId);
				return { spokenSuffix: sup(msg) };
			}
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
