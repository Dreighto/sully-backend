// Shared chat-turn server service. Both POST /api/chat and POST /api/chat/sdk-stream
// used to own their OWN copy of:
//   - persist operator message,
//   - touch thread meta + last_activity,
//   - read prior history,
//   - classify the conversation tier,
//   - persist the assistant reply on completion,
// in lockstep. A fix to any of those had to be remembered twice (the largest
// drift surface in the synthesis review). This module owns the single shared
// version; the route handlers stay thin.

import { randomBytes } from 'node:crypto';
import {
	addChatMessage,
	getChatMessages,
	setActiveThread,
	getOperatorTurnByClientId,
	insertOperatorTurnKeyed,
	deleteChatRepliesForTask,
	type MessageForensics
} from './chat';
import type { ChatMessage } from '$lib/types/chat';
import { classifyTier, type Tier } from './phase_classifier';
import { getThreadState, upsertThreadTier, type ThreadState } from './thread_state';
import { touchLastActivity, upsertThreadMeta } from './thread_meta';
import { maybeUpdateThreadSummary } from './working_memory';
import { maybeAutoTitle } from './auto_title';
import { proposeTask, markClassified, expireProposalsForThread } from './dispatchJobs';
import { isAffirmation, isRoutingAnswer } from './routing/confirm';
import { logTaskEvent } from './chatActivity';
import { honestyObserve } from './brains/honesty';

/**
 * Mint a Task id for a turn. Shared by the text pipeline (stream_prepare) and
 * the voice pipeline (voice-reply) so both speak the same task-lifecycle
 * language. Keeps the `sully-` prefix the render layer keys on (WorkingBubble
 * mounts when a system row's trace_id starts with 'sully-'), plus a random
 * suffix so two turns in the same millisecond can't collide on the
 * pending_jobs.trace_id UNIQUE constraint.
 */
export function mintTaskId(): string {
	return `sully-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

/**
 * Persist the operator's incoming turn. Returns the row (so the route can return
 * it to the polled feed), the EFFECTIVE task id, and whether this call reused an
 * existing turn instead of writing a new one.
 *
 * Phase 1: carries task_id so the operator row links to its Task, and mints the
 * 'proposed' Task row up-front. Every turn (text or voice, dispatched or not)
 * gets a Task — the unit of work — before any routing decision.
 *
 * Stage 2 (idempotent operator-turn persistence): when `clientTurnId` is PRESENT,
 * one logical turn = at most one operator row, keyed on (threadId, clientTurnId).
 * A retry/regenerate re-POSTs the SAME turn with a fresh request id; keying on the
 * client-supplied id makes the re-POST REUSE the original row + its Task instead
 * of minting a duplicate operator row + a second 'proposed' Task. When `clientTurnId`
 * is ABSENT, behaviour is byte-identical to before (insert + proposeTask). The key
 * is the id and NEVER the text, so a fresh send with a NEW id (or no id) can never
 * collapse a genuine repeat.
 */
export function persistUserTurn(args: {
	text: string;
	threadId: string;
	sender?: string;
	ticketId?: string | null;
	taskId?: string;
	source?: string;
	/** Stage 2 idempotency key. Absent → today's behaviour, exactly. */
	clientTurnId?: string | null;
}): { row: ChatMessage; taskId?: string; reused: boolean } {
	const text = args.text.trim();
	const clientTurnId = args.clientTurnId ?? null;
	const source = args.source ?? 'chat';

	// Mint the up-front 'proposed' Task for a genuinely-NEW turn. One definition
	// shared by the keyed + unkeyed insert paths; skipped entirely on reuse.
	const propose = () => {
		if (!args.taskId) return;
		proposeTask({
			taskId: args.taskId,
			threadId: args.threadId,
			source,
			category: 'general',
			brief: text.slice(0, 280)
		});
		logTaskEvent(args.taskId, 'task_proposed', { source });
	};

	// ── Idempotent path — client supplied a per-turn key ──────────────────────
	if (clientTurnId) {
		// Fast path: the same logical turn already landed (retry/regenerate).
		const existing = getOperatorTurnByClientId(args.threadId, clientTurnId);
		if (existing) {
			// REUSE — hand back the original row + its Task. Do NOT proposeTask again.
			return { row: existing.row, taskId: existing.taskId ?? args.taskId, reused: true };
		}
		// First sight of this key. Race-safe insert; the partial unique index
		// collapses a concurrent duplicate of the SAME turn to one operator row.
		const {
			row,
			taskId: rowTaskId,
			inserted
		} = insertOperatorTurnKeyed({
			sender: args.sender || 'operator',
			message: text,
			ticketId: args.ticketId ?? null,
			threadId: args.threadId,
			clientTurnId,
			taskId: args.taskId ?? null
		});
		if (!inserted) {
			// Lost the race to a concurrent POST of the SAME turn — treat as reuse so
			// we never double-propose (the winner proposed / will propose its Task).
			return { row, taskId: rowTaskId ?? args.taskId, reused: true };
		}
		// We wrote the canonical operator row → mint its Task now (the row already
		// carries task_id via the keyed insert).
		propose();
		return { row, taskId: args.taskId, reused: false };
	}

	// ── Unkeyed path — byte-identical to the pre-Stage-2 behaviour ────────────
	propose();
	const row = addChatMessage(
		args.sender || 'operator',
		text,
		null,
		args.ticketId ?? null,
		null,
		'sent',
		args.threadId,
		args.taskId ? { taskId: args.taskId } : {}
	);
	return { row, taskId: args.taskId, reused: false };
}

/**
 * After persisting the user turn: ensure the meta row exists, touch
 * last_activity, classify the conversation tier from the recent history, and
 * persist the classifier's result against the thread state. Returns the
 * resolved tier + the current thread state so the caller can route on
 * provider override / current model / etc.
 */
export function classifyAndTouchThread(args: {
	threadId: string;
	userText: string;
	taskId?: string;
}): {
	currentTier: Tier;
	threadState: ThreadState;
} {
	upsertThreadMeta(args.threadId, {});
	touchLastActivity(args.threadId);
	// Persist the active thread on EVERY real turn (text AND voice — both pipelines
	// converge here). This is the core thread-resume seam: without it the restore
	// order has no last-active thread to come back to. touchLastActivity above only
	// stamps the thread's own meta; it does NOT record which thread the operator is
	// in. setActiveThread is the missing write (LOS-178).
	setActiveThread(args.threadId);

	// Ask-before-dispatch: a pending proposal lives ONLY for the operator's
	// immediate next reply. Any turn that is NOT an affirmation AND NOT a routing
	// answer expires it here — unconditionally, before the reply — so a proposal
	// can't survive an errored or empty-reply turn and later fire on an unrelated
	// "yes". An affirmation turn leaves it for maybeAutonomousDispatch to consume
	// (dispatch). A routing answer ("hold it" / "run it separately") also leaves
	// it so maybeAutonomousDispatch can consume the routing_ask proposal; without
	// this guard the routing_ask is aborted before consumption and the held work
	// is silently lost.
	if (!isAffirmation(args.userText) && !isRoutingAnswer(args.userText))
		expireProposalsForThread(args.threadId);

	const threadState = getThreadState(args.threadId);
	const allForClassify = getChatMessages(30, args.threadId);
	// Exclude the JUST-inserted operator message — the classifier's depth signal
	// reads assistant turns, not the prompt currently in flight.
	const recentForClassify = allForClassify.slice(0, -1);
	const currentTier = classifyTier({
		userMessage: args.userText.trim(),
		recentMessages: recentForClassify,
		currentTier: threadState.current_tier,
		operatorOverride: threadState.operator_override
	});
	// Persist with model=null — the assistant turn will set the actual model id.
	upsertThreadTier(args.threadId, currentTier, null);
	// Journal the classification decision against the Task. This is the routing
	// signal v3 will eventually train on: (turn → tier → was-it-right via the
	// reply's quality_signal).
	if (args.taskId) {
		markClassified(
			args.taskId,
			currentTier,
			JSON.stringify({ operator_override: threadState.operator_override ?? null })
		);
		logTaskEvent(args.taskId, 'classifier_ran', {
			tier: currentTier,
			operator_override: threadState.operator_override ?? null
		});
	}
	return { currentTier, threadState };
}

/**
 * On the assistant's reply landing: persist it, advance the thread tier with
 * the actual model id used, touch activity. Caller stays responsible for the
 * sender label ('cc'/'agy'/'companion'/etc.) since that varies by route.
 */
export function persistAssistantTurn(args: {
	text: string;
	sender: string;
	threadId: string;
	model: string;
	tier: Tier;
	// Phase 1 forensics — task_id links the reply to its Task; provider/tokens/
	// latency/error make the turn auditable from the DB (turn_replay reads them).
	taskId?: string;
	// Links the reply row to an artifact trace (e.g. a teacher-created
	// SULLY_ARTIFACT) so the render layer mounts an inline card for it.
	traceId?: string | null;
	provider?: string | null;
	promptTokens?: number | null;
	completionTokens?: number | null;
	latencyMs?: number | null;
	error?: string | null;
	/** Row status. Defaults to 'sent'. Voice barge-in / truncate sets
	 *  'truncated' so downstream consumers (history rehydrate, voice context
	 *  rebuilds) can tell what the operator actually heard vs what was
	 *  generated. */
	status?: string;
	/**
	 * Stage 3a (replace-reply-on-reuse): TRUE when this turn REUSED an existing
	 * keyed operator row + Task (a retry/regenerate re-POST — same client_turn_id).
	 * When set, the PRIOR chat reply(ies) for this reused Task are deleted BEFORE
	 * the new reply is written, so a regenerate REPLACES the stale reply instead of
	 * appending a second one (which would otherwise reappear on the next history
	 * sync/reopen). FALSE / absent → byte-identical to the pre-Stage-3a behaviour:
	 * append only, delete nothing. Only ever passed by the sdk-stream chat paths
	 * (CLI/direct/local); voice + unkeyed turns leave it false.
	 */
	reused?: boolean;
	/**
	 * Honesty shadow observation: list of tool names actually called this turn.
	 * When present, `auditTurn` runs against the reply text and any fabrication
	 * flags are logged to the honesty corpus. Absent → no-op (backward
	 * compatible). Added post-PR #87 to wire the honesty monitor into production
	 * reply paths without blocking anything.
	 */
	toolCallsThisTurn?: string[];
}): number {
	// Stage 3a: on a keyed REUSE, this new reply REPLACES the prior one — delete the
	// stale chat reply(ies) for this reused Task BEFORE writing the new row (so we
	// never delete the row we are about to insert). Tightly scoped in the helper by
	// (task_id AND chat-reply sender-set): never touches the operator row or the
	// system/dispatch ACK, and — keyed on THIS reused task_id — never a synthesis
	// reply for a different turn. On a retry-of-a-failed-send (reused, no prior reply)
	// it is a harmless 0-row no-op. reused===false does nothing new.
	if (args.reused === true && args.taskId) {
		deleteChatRepliesForTask(args.taskId);
	}
	// Caller (route handler) already decided this turn is worth persisting —
	// don't second-guess with a .trim() guard. Originally both routes advanced
	// tier+activity regardless of text content; an internal trim here silently
	// dropped the state advance on whitespace-only replies. Caller's call.
	const forensics: MessageForensics = {
		taskId: args.taskId ?? null,
		model: args.model,
		provider: args.provider ?? null,
		promptTokens: args.promptTokens ?? null,
		completionTokens: args.completionTokens ?? null,
		latencyMs: args.latencyMs ?? null,
		error: args.error ?? null
	};
	const insertedReply = addChatMessage(
		args.sender,
		args.text,
		args.traceId ?? null,
		null,
		null,
		args.status ?? 'sent',
		args.threadId,
		forensics
	);
	upsertThreadTier(args.threadId, args.tier, args.model);
	touchLastActivity(args.threadId);
	if (args.taskId) {
		logTaskEvent(args.taskId, 'reply_persisted', {
			sender: args.sender,
			model: args.model,
			provider: args.provider ?? null,
			latency_ms: args.latencyMs ?? null,
			error: args.error ?? null
		});
	}

	// Layer 1 (working memory): refresh the pre-hot-window summary in the
	// background. Fire-and-forget — never block the reply.
	void maybeUpdateThreadSummary(args.threadId).catch(() => {});

	// Auto-name the thread from its first exchange. Fire-and-forget; self-skips
	// once titled or operator-renamed. Was only wired into the image-reply path,
	// so text conversations stayed "New thread" — this covers every reply path
	// that persists an assistant turn (direct/CLI/local/voice).
	void maybeAutoTitle(args.threadId).catch(() => {});

	// Honesty shadow observation: audit every reply for fabricated tool syntax
	// and (when tool call data is available) unbacked action claims. Logs flags
	// to the honesty corpus. Fire-and-forget — never blocks the reply stream.
	// Runs AFTER the reply is persisted so the corpus has the final text.
	honestyObserve(args.text, args.toolCallsThisTurn ?? [], args.threadId);

	// Stage 1 (server-owned reply-id): return the persisted chat_messages.id so the
	// manual-writer stream paths can emit a terminal data-sully-reply-id frame,
	// letting the client reconcile the streamed reply to its stored row without
	// polling history. Additive — existing callers that ignore the return are
	// byte-for-byte unaffected.
	return insertedReply.id;
}
