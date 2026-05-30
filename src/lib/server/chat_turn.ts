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

import { addChatMessage, getChatMessages } from './chat';
import { classifyTier, type Tier } from './phase_classifier';
import {
	getThreadState,
	upsertThreadTier,
	type ThreadState
} from './thread_state';
import { touchLastActivity, upsertThreadMeta } from './thread_meta';
import { maybeUpdateThreadSummary } from './working_memory';

/**
 * Persist the operator's incoming turn. Returns the row so the route can return
 * it to the caller (the legacy route does this for the polled feed).
 */
export function persistUserTurn(args: {
	text: string;
	threadId: string;
	sender?: string;
	ticketId?: string | null;
}) {
	return addChatMessage(
		args.sender || 'operator',
		args.text.trim(),
		null,
		args.ticketId ?? null,
		null,
		'sent',
		args.threadId
	);
}

/**
 * After persisting the user turn: ensure the meta row exists, touch
 * last_activity, classify the conversation tier from the recent history, and
 * persist the classifier's result against the thread state. Returns the
 * resolved tier + the current thread state so the caller can route on
 * provider override / current model / etc.
 */
export function classifyAndTouchThread(args: { threadId: string; userText: string }): {
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
}): void {
	// Caller (route handler) already decided this turn is worth persisting —
	// don't second-guess with a .trim() guard. Originally both routes advanced
	// tier+activity regardless of text content; an internal trim here silently
	// dropped the state advance on whitespace-only replies. Caller's call.
	addChatMessage(args.sender, args.text, null, null, null, 'sent', args.threadId);
	upsertThreadTier(args.threadId, args.tier, args.model);
	touchLastActivity(args.threadId);

	// Layer 1 (working memory): refresh the pre-hot-window summary in the
	// background. Fire-and-forget — never block the reply.
	void maybeUpdateThreadSummary(args.threadId).catch(() => {});
}
