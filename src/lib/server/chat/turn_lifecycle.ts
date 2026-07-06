import { type Tier } from '$lib/server/phase_classifier';
import { type ThreadState } from '$lib/server/thread_state';
import { persistUserTurn, classifyAndTouchThread, mintTaskId } from '$lib/server/chat_turn';
import { runMutationGate, type MutationGateResult } from '$lib/server/routing/mutation_gate';
import { resolveTurnDecision, type TurnDecision } from '$lib/server/routing/turn_decision';
import { logTaskEvent } from '$lib/server/chatActivity';
import { normalizeInputText, sourceToNormalizationMode } from '$lib/server/input_normalizer';
import { detectTargetRepo } from './target_repo';

export interface PrepareTurnLifecycleArgs {
	/** The user's message text for this turn. */
	text: string;
	/** Resolved thread id. */
	threadId: string;
	/** Sender label — defaults to 'operator'. */
	sender?: string;
	/** Where this turn entered from — 'chat' | 'voice' | 'walkie'. Defaults to 'chat'. */
	source?: string;
	/** Optional explicit target repo hint (keyword-scan fallback if absent). */
	targetRepoHint?: string;
	/**
	 * Stage 2 idempotency key — a client-supplied per-turn id. When present, a
	 * retry/regenerate re-POST of the SAME turn reuses its original operator row +
	 * Task instead of minting duplicates. Absent → today's behaviour, unchanged.
	 */
	clientTurnId?: string | null;
}

export interface TurnLifecycleResult {
	taskId: string;
	currentTier: Tier;
	threadState: ThreadState;
	targetRepo: string;
	userMessageText: string;
	/**
	 * chat_messages.id of THIS turn's own operator row (just persisted). Used by
	 * the hot-window assembly to scope history to this turn's boundary so a
	 * concurrent peer turn on the same thread can't cross-contaminate the reply.
	 */
	operatorRowId: number;
	/**
	 * Stage 2: TRUE when this turn REUSED an existing operator row + Task (a keyed
	 * retry/regenerate re-POST) rather than persisting a fresh one. Surfaced so the
	 * caller can tell reuse from a fresh insert — critical for the Stage 1 orphan
	 * rollback, which must NEVER delete a reused (pre-existing, already-answered)
	 * operator row or expire its handled Task. FALSE on every genuinely-new turn
	 * (and on every unkeyed turn — today's behaviour).
	 */
	reused: boolean;
	/** Result of the Mutation Gate (R2). Required — compile-enforced so the turn can't proceed without it. */
	mutationGate: MutationGateResult;
	/** Pre-stream shadow decision (D1). Journaled only — does not alter reply or dispatch. */
	shadowDecision: TurnDecision;
}

/**
 * The shared turn-lifecycle preamble: mint a Task id, persist the operator
 * turn, classify + touch the thread, and resolve the target repo. Both the
 * text pipeline (prepareStream) and the voice pipeline (voice-reply) call this
 * before diverging into their respective prompt builds. The Mutation Gate (R2)
 * hooks in here — one chokepoint, impossible to bypass.
 */
export async function prepareTurnLifecycle(
	args: PrepareTurnLifecycleArgs
): Promise<TurnLifecycleResult> {
	const { text, threadId } = args;
	const source = args.source ?? 'chat';
	const normalizedText = normalizeInputText(text, sourceToNormalizationMode(source));

	const taskId = mintTaskId();
	// Capture the persisted operator row so the hot-window assembly (prepareStream)
	// can pin its history to THIS turn's own boundary (row id) and never pull in a
	// concurrent peer turn's freshly-persisted operator row. Stage 2: on a keyed
	// re-POST (retry/regenerate), persistUserTurn REUSES the original row + Task
	// instead of minting duplicates — `reused` tells us which taskId is effective.
	const persisted = persistUserTurn({
		text: normalizedText,
		threadId,
		taskId,
		source,
		sender: args.sender,
		clientTurnId: args.clientTurnId
	});
	// CRITICAL ORDERING: on reuse the EFFECTIVE task id is the existing row's
	// task_id — NOT the freshly minted one. Rebind HERE, BEFORE classify runs, so
	// the classifier journal + tier attach to the reused row's Task (a fresh id
	// would orphan the classify trail from the row it belongs to). persistUserTurn
	// already skipped the up-front proposeTask + task_proposed journal on reuse, so
	// classifyAndTouchThread below only re-touches the tier (idempotent) — it never
	// re-proposes. On a genuinely-new turn effectiveTaskId === taskId, unchanged.
	const operatorRow = persisted.row;
	const effectiveTaskId = persisted.reused ? (persisted.taskId ?? taskId) : taskId;
	const { currentTier, threadState } = classifyAndTouchThread({
		threadId,
		userText: normalizedText,
		taskId: effectiveTaskId
	});
	const targetRepo = detectTargetRepo(normalizedText, args.targetRepoHint);
	// R2: run the Mutation Gate after classify (so the active-task query is
	// post-classify, not pre). One chokepoint — impossible to bypass.
	const mutationGate = runMutationGate(threadId, normalizedText);

	// D1.2: shadow-compute the turn decision pre-stream (deterministic — no gateBlock).
	// Read-only + one journal write. Does NOT alter the reply or dispatch path.
	const shadowDecision = resolveTurnDecision({
		userText: normalizedText,
		threadId,
		mutationGate,
		tier: currentTier
	});
	logTaskEvent(effectiveTaskId, 'turn_decision_shadow', { kind: shadowDecision.kind });

	return {
		taskId: effectiveTaskId,
		currentTier,
		threadState,
		targetRepo,
		userMessageText: normalizedText,
		operatorRowId: operatorRow.id,
		// Surface reuse so the route's orphan rollback can tell a freshly-persisted
		// operator row (rollback-eligible) from a reused one (NEVER roll back).
		reused: persisted.reused,
		mutationGate,
		shadowDecision
	};
}
