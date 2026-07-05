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
// CRITICAL: the hot-window assembly below is the model-amnesia fix — the
// frontend resets its SDK chat each send, so body.messages carries only the
// current turn. The server is the single source of truth for conversation
// history. This logic is moved here VERBATIM and must not regress.

import { type UIMessage } from 'ai';
import { getChatMessages } from '$lib/server/chat';
import { type Tier } from '$lib/server/phase_classifier';
import { type ThreadState } from '$lib/server/thread_state';
import { runMode, appIdentity, serverConfig } from '$lib/server/config';
import { persistUserTurn, classifyAndTouchThread, mintTaskId } from '$lib/server/chat_turn';
import { buildSystemPrompt } from '$lib/server/chat_prompt';
import { resolveChatModel } from '$lib/server/model_catalog';
import { providerPrefToApi } from '$lib/chat/model-registry';
import { runMutationGate, type MutationGateResult } from '$lib/server/routing/mutation_gate';
import { resolveTurnDecision, type TurnDecision } from '$lib/server/routing/turn_decision';
import { logTaskEvent } from '$lib/server/chatActivity';
import {
	normalizeInputText,
	normalizeLatestUserMessage,
	sourceToNormalizationMode
} from '$lib/server/input_normalizer';

export type Provider = 'anthropic' | 'google' | 'local';

// Repo selection from message text — same keyword-scan heuristic as the
// legacy endpoint. Client may also pass an explicit `target_repo`. Exported so
// the voice pipeline derives the dispatch target the same way text does.
export function detectTargetRepo(message: string, hint?: string): string {
	if (hint) return hint;
	const text = message.toLowerCase();
	if (text.includes('miru')) return 'project-miru';
	if (
		text.includes('orchestrator') ||
		text.includes('kernel') ||
		text.includes('logueos-orchestrator')
	) {
		return 'LogueOS-Orchestrator';
	}
	if (text.includes('nasdoom')) return 'NASDOOM';
	// Phase 5 / 5a: artifact builds route to Sully's workspace — AFTER the existing-repo
	// checks above (so "fix the console build" / repo-named work still wins). Triggers on
	// an explicit workspace reference OR an artifact-creation phrase (a build verb + an
	// artifact noun like project/dashboard/mockup). Precise by design — a bare "build"
	// with no artifact noun and no workspace word falls through to the default.
	if (
		text.includes('sully-workspace') ||
		/\b(?:in|into|to|my) (?:the )?workspace\b/.test(text) ||
		/\b(?:build|create|make|generate|scaffold|draft|put|add)\b[^.!?]*\b(?:project|dashboard|mockup|artifact|site|page|app|landing)\b/.test(
			text
		)
	) {
		return 'sully-workspace';
	}
	// Fork-aware fallback: companion mode → 'companion', wired → 'LogueOS-Console'.
	return appIdentity.defaultWorkspace;
}

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

	// ── Hot window ──────────────────────────────────────────────────────────
	// The frontend resets its SDK chat each send (streaming.svelte.ts), so
	// `body.messages` carries only the CURRENT turn. The server is the single
	// source of truth: assemble the model's real conversation from chat_messages
	// here. Without this, switching models mid-thread (or any second turn) ships
	// the new turn with NO history — the model genuinely "forgets" the chat.
	// HOT_WINDOW must match working_memory.ts (the Layer-1 summary covers only
	// older-than-window history; these last turns are sent verbatim).
	const HOT_WINDOW = 20;
	// Concurrency scope (M6): two operator messages sent to the SAME thread ~1-2s
	// apart used to cross-contaminate — the later turn read the earlier, still
	// in-flight peer's freshly-persisted operator row into its window and answered
	// BOTH messages (the old `slice(0, len - messages.length)` only dropped a fixed
	// count from the end, so a peer's dangling operator row survived). Pin the
	// window to THIS turn's own operator row instead, keyed off its just-persisted
	// row id:
	//   1. Exclude any row a later peer persisted AFTER our snapshot (id >
	//      operatorRowId) — not part of this turn's history.
	//   2. Drop the TRAILING run of operator rows — our own just-persisted text copy
	//      PLUS any concurrent-peer operator row(s) that landed alongside it — then
	//      append the body's rich copy of our own turn instead (it preserves parts
	//      like image attachments that chat_messages stores only as text).
	// A settled (non-concurrent) thread ends in exactly ONE trailing operator row —
	// this turn's own — so single-send history is unchanged from before.
	const windowRows = getChatMessages(HOT_WINDOW, threadId).filter(
		(r) =>
			r.sender !== 'system' &&
			typeof r.message === 'string' &&
			r.message.trim() !== '' &&
			r.id <= operatorRowId
	);
	let priorCut = windowRows.length;
	while (priorCut > 0 && windowRows[priorCut - 1].sender === 'operator') priorCut--;
	const priorTurns: UIMessage[] = windowRows.slice(0, priorCut).map(
		(r) =>
			({
				id: String(r.id),
				role: r.sender === 'operator' ? 'user' : 'assistant',
				parts: [{ type: 'text', text: r.message }]
			}) as UIMessage
	);
	const modelMessages: UIMessage[] = [...priorTurns, ...messages];

	const targetRepo = lifecycleTargetRepo;

	// Provider preference:
	//   1. Explicit body.provider (client just chose a model)
	//   2. thread_state.provider_override (persisted via model picker)
	//   3. Default 'google' (matches legacy AGY-chat-lock UX). Operator can
	//      flip to Anthropic via picker; Anthropic-via-OAuth is free.
	const overrideFromState: Provider | undefined = providerPrefToApi(threadState.provider_override);
	// Tier 'local' implicitly selects the local provider unless the operator
	// has explicitly overridden. Lets the existing "Local (Ollama)" model
	// picker option route through Ollama without per-thread setup.
	const tierImpliesLocal: Provider | null = currentTier === 'local' ? 'local' : null;
	// Companion mode defaults to the LOCAL provider (companion-v1) instead of
	// cloud Google — while keeping cloud models selectable via the picker.
	// COMPANION_LOCAL_DISABLED env flag (operator-controlled) suppresses the
	// implicit local default so Auto never loads a GPU model. Used when the
	// GPU is busy with QLoRA training or other workloads. The picker's
	// explicit "Local (Ollama)" option still works because that path sets
	// args.provider='local' which takes priority over this default.
	const companionDefault: Provider | null =
		runMode.companion && !serverConfig.companionLocalDisabled ? 'local' : null;
	const autoMode = args.provider === undefined || args.provider === null;
	// Auto mode resolves provider/model dynamically in auto_router.ts (tier →
	// anthropic → google → Ollama Cloud DeepSeek). The placeholder here is only
	// used for system-prompt assembly and CLI-bridge hints until +server.ts
	// overwrites it with the resolved lane.
	const provider: Provider = autoMode
		? 'anthropic'
		: (args.provider ?? overrideFromState ?? tierImpliesLocal ?? companionDefault ?? 'google');

	// Resolve the model id up-front so we can decide between the direct API
	// route and the Claude CLI bridge. Anthropic's Claude Max OAuth only
	// grants direct API access to Haiku — Sonnet/Opus return 429 with a
	// mislabel'd "rate_limit_error". The CLI binary is the authorized client
	// that CAN reach Sonnet/Opus through OAuth. Operator directive 2026-05-27:
	// "use the CLI bridge, do NOT prompt for a billed API key — defeats the
	// purpose of paying for Max." So Sonnet/Opus ALWAYS route through CLI
	// regardless of any API-key env presence.
	// Resolve via the shared catalog — precedence: body.model → companion-mode
	// local default (companion-v1) → tier × provider matrix. Used here UP-FRONT
	// to decide between the direct API path and the CLI bridge.
	const resolvedModelId = resolveChatModel({
		tier: currentTier,
		provider,
		requestedModel: args.model
	});
	const useClaudeCLI = provider === 'anthropic' && /sonnet|opus/i.test(resolvedModelId);

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
