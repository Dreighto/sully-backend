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
import { addChatMessage, getChatMessages, type MessageForensics } from './chat';
import { classifyTier, type Tier } from './phase_classifier';
import { getThreadState, upsertThreadTier, type ThreadState } from './thread_state';
import { touchLastActivity, upsertThreadMeta } from './thread_meta';
import { maybeUpdateThreadSummary } from './working_memory';
import { proposeTask, markClassified } from './dispatchJobs';
import { logTaskEvent } from './chatActivity';

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
 * Persist the operator's incoming turn. Returns the row so the route can return
 * it to the caller (the legacy route does this for the polled feed).
 *
 * Phase 1: carries task_id so the operator row links to its Task, and mints the
 * 'proposed' Task row up-front. Every turn (text or voice, dispatched or not)
 * gets a Task — the unit of work — before any routing decision.
 */
export function persistUserTurn(args: {
	text: string;
	threadId: string;
	sender?: string;
	ticketId?: string | null;
	taskId?: string;
	source?: string;
}) {
	if (args.taskId) {
		proposeTask({
			taskId: args.taskId,
			threadId: args.threadId,
			source: args.source ?? 'chat',
			category: 'general',
			brief: args.text.trim().slice(0, 280)
		});
		logTaskEvent(args.taskId, 'task_proposed', { source: args.source ?? 'chat' });
	}
	return addChatMessage(
		args.sender || 'operator',
		args.text.trim(),
		null,
		args.ticketId ?? null,
		null,
		'sent',
		args.threadId,
		args.taskId ? { taskId: args.taskId } : {}
	);
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
	provider?: string | null;
	promptTokens?: number | null;
	completionTokens?: number | null;
	latencyMs?: number | null;
	error?: string | null;
}): void {
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
	addChatMessage(args.sender, args.text, null, null, null, 'sent', args.threadId, forensics);
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
}
