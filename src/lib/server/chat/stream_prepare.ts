// Shared preamble for the SDK-native streaming endpoint
// (src/routes/api/chat/sdk-stream/+server.ts).
//
// Both streaming engines — the Claude CLI bridge (Sonnet/Opus over OAuth) and
// the direct SDK path (streamText) — run an identical set-up sequence before
// they diverge: persist the operator's turn, classify the tier, assemble the
// "hot window" of recent history, detect the target repo, resolve the provider
// + model, decide CLI-vs-direct, compute sensitive-tool gating, and build the
// system prompt. This module owns that single shared version so the route
// handler stays a thin orchestrator (parse → prepare → branch) and the two
// paths can never drift on the preamble.
//
// CRITICAL: the hot-window assembly (./hot_window.ts) is the model-amnesia
// fix — the frontend resets its SDK chat each send, so body.messages carries
// only the current turn. The server is the single source of truth for
// conversation history. This logic must not regress.
//
// Wave 4 split (2026-07-06): detectTargetRepo moved to ./target_repo.ts,
// prepareTurnLifecycle to ./turn_lifecycle.ts, the hot-window assembly to
// ./hot_window.ts, and provider/model resolution to ./provider_resolve.ts.
// Load-bearing invariant comments (Stage-2 idempotency ordering, R2 gate
// ordering, the M6 concurrency-scope hot-window logic) travel with their code
// in those files. All are re-exported here so the ~19 external call sites
// need no import-path changes.

import { type UIMessage } from 'ai';
import { type Tier } from '$lib/server/phase_classifier';
import { type ThreadState } from '$lib/server/thread_state';
import { buildSystemPrompt } from '$lib/server/chat_prompt';
import { type MutationGateResult } from '$lib/server/routing/mutation_gate';
import { type TurnDecision } from '$lib/server/routing/turn_decision';
import {
	normalizeLatestUserMessage,
	sourceToNormalizationMode
} from '$lib/server/input_normalizer';
import { prepareTurnLifecycle } from './turn_lifecycle';
import { buildHotWindow } from './hot_window';
import { resolveProviderAndModel, type Provider } from './provider_resolve';

export { detectTargetRepo } from './target_repo';
export {
	prepareTurnLifecycle,
	type PrepareTurnLifecycleArgs,
	type TurnLifecycleResult
} from './turn_lifecycle';
export { type Provider } from './provider_resolve';

export interface PrepareArgs {
	/** The body's current-turn messages (validated non-empty by the caller). */
	messages: UIMessage[];
	/** Resolved thread id (caller normalises 'default' fallback). */
	threadId: string;
	/** The latest user text (caller extracts + validates non-empty). */
	userText: string;
	/** Optional client-chosen provider. */
	provider?: Provider;
	/** Optional client-chosen model id. */
	model?: string;
	/** Optional explicit target repo from the body. */
	targetRepoHint?: string;
	/** Request headers — funnel detection + tools-key unlock. */
	headers: Headers;
	/**
	 * Where this turn entered from — 'chat' (typed) or 'voice' (spoken). Both
	 * go through this same prepare path; the source is recorded on the Task so
	 * the journal can distinguish voice-driven from text-driven work without
	 * the two pipelines diverging. Defaults to 'chat'.
	 */
	source?: string;
	/**
	 * True when the client signals the reply will be SPOKEN aloud (dictation /
	 * voice mode). Forwarded to buildSystemPrompt so the model gets a
	 * voice-mode addendum (conversational tone, no markdown tables/lists). The
	 * dispatch + journal pipelines don't change.
	 */
	spoken?: boolean;
	/**
	 * Stage 2 idempotency key — client-supplied per-turn id off the request body.
	 * Threaded to prepareTurnLifecycle so a retry/regenerate re-POST reuses the
	 * original operator row + Task. Additive + optional; absent → today's behaviour.
	 */
	clientTurnId?: string | null;
}

export interface PreparedStreamContext {
	messages: UIMessage[];
	threadId: string;
	/**
	 * The Task id for this turn. Minted up-front (before any DB write) so the
	 * operator row, assistant row, journal events, and any dispatched job all
	 * carry the same handle. Starts with 'sully-'. This is the key the reader
	 * API (turn_replay) queries.
	 */
	taskId: string;
	/**
	 * The latest user message text both paths feed to autonomous dispatch +
	 * the system prompt. This is the SPACE-JOINED, trimmed form (the original
	 * `userMessageText`), NOT the no-separator validation form used for
	 * persist/classify. Behaviour-preserving: the dispatch gates + system prompt
	 * always consumed the space-joined value.
	 */
	userText: string;
	/**
	 * chat_messages.id of THIS turn's own operator row (persisted in
	 * prepareTurnLifecycle). Surfaced so the route can roll it back on a
	 * zero-token orphan turn (pre-stream credential 503, or a stream that
	 * errored having emitted no reply text + written no assistant row). Scoped
	 * to this exact row — never thread-wide.
	 */
	operatorRowId: number;
	/**
	 * Stage 2: TRUE when the operator turn was REUSED (a keyed retry/regenerate
	 * re-POST reused its original row + Task) rather than freshly persisted. The
	 * route MUST gate every orphan rollback on this — rolling back a reused row
	 * would delete the operator's pre-existing, already-answered message and expire
	 * its handled Task. Only a fresh insert (reused===false) is a rollback-eligible
	 * orphan.
	 */
	reused: boolean;
	currentTier: Tier;
	threadState: ThreadState;
	targetRepo: string;
	/** True when the client omitted `provider` (picker = Auto). */
	autoMode: boolean;
	provider: Provider;
	resolvedModelId: string;
	useClaudeCLI: boolean;
	allowSensitive: boolean;
	systemPrompt: string;
	modelMessages: UIMessage[];
	/** Result of the Mutation Gate (R2). Required — compile-enforced. */
	mutationGate: MutationGateResult;
	/** Pre-stream shadow decision (D1). Journaled only — does not alter reply or dispatch. */
	shadowDecision: TurnDecision;
}

function latestUserText(messages: UIMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== 'user') continue;
		const text = (message.parts || [])
			.filter((part) => part.type === 'text')
			.map((part) => (part as { type: 'text'; text: string }).text)
			.join(' ')
			.trim();
		if (text) return text;
	}
	return '';
}

/**
 * Run the shared preamble both streaming paths depend on and return a context
 * object carrying every field they need. The route handler keeps the
 * body-parse + early validation returns, then calls this, then branches on
 * `useClaudeCLI`.
 */
export async function prepareStream(args: PrepareArgs): Promise<PreparedStreamContext> {
	const normalizationMode = sourceToNormalizationMode(args.source);
	const messages = normalizeLatestUserMessage(args.messages, normalizationMode);
	const { threadId } = args;
	const userText = args.userText || latestUserText(messages);

	// Shared turn-lifecycle preamble: mint Task id, persist operator turn,
	// classify + touch thread, resolve target repo. Both text + voice call this
	// same function — the Mutation Gate (R2) will hook in here.
	const {
		taskId,
		currentTier,
		threadState,
		targetRepo: lifecycleTargetRepo,
		operatorRowId,
		reused,
		mutationGate,
		shadowDecision
	} = await prepareTurnLifecycle({
		text: userText,
		threadId,
		source: args.source,
		targetRepoHint: args.targetRepoHint,
		clientTurnId: args.clientTurnId
	});

	const modelMessages = buildHotWindow(threadId, operatorRowId, messages);

	const targetRepo = lifecycleTargetRepo;

	const { autoMode, provider, resolvedModelId, useClaudeCLI } = resolveProviderAndModel({
		argsProvider: args.provider,
		requestedModel: args.model,
		currentTier,
		threadState
	});

	// Sensitive machine-read + web tools are attached only for the operator's own
	// devices. Two ways to qualify:
	//   1. Tailnet path — the request did NOT arrive over the public Funnel (no
	//      `Tailscale-Funnel-Request` header).
	//   2. Unlock code — the device sent a valid `x-companion-tools-key` header
	//      matching COMPANION_TOOLS_KEY. This lets the operator turn the powers on
	//      over the normal public Funnel link (via `/unlock <code>`), since a
	//      non-standard tailnet port doesn't reliably open on phones. The code is
	//      stored per-device in localStorage; public visitors don't have it.
	// Public visitors with neither get chat + the safe context tools only.
	const viaFunnel = args.headers.get('tailscale-funnel-request') !== null;
	const TOOLS_SECRET = process.env.COMPANION_TOOLS_KEY || '';
	const providedKey = args.headers.get('x-companion-tools-key') || '';
	const keyValid = TOOLS_SECRET.length > 0 && providedKey === TOOLS_SECRET;
	const allowSensitive = !viaFunnel || keyValid;

	const userMessageText =
		[...messages]
			.reverse()
			.find((m) => m.role === 'user')
			?.parts?.filter((p) => p.type === 'text')
			.map((p) => (p as { type: 'text'; text: string }).text)
			.join(' ')
			.trim() || '';
	const systemPrompt = await buildSystemPrompt(
		{ targetRepo, currentTier, threadId, allowSensitive, spoken: args.spoken === true },
		userMessageText
	);

	return {
		messages,
		threadId,
		taskId,
		userText: userMessageText,
		operatorRowId,
		reused,
		currentTier,
		threadState,
		targetRepo,
		autoMode,
		provider,
		resolvedModelId,
		useClaudeCLI,
		allowSensitive,
		systemPrompt,
		modelMessages,
		mutationGate,
		shadowDecision
	};
}
