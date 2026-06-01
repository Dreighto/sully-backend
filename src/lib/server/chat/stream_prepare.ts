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
import { runMode, appIdentity } from '$lib/server/config';
import { persistUserTurn, classifyAndTouchThread } from '$lib/server/chat_turn';
import { buildSystemPrompt } from '$lib/server/chat_prompt';
import { resolveChatModel } from '$lib/server/model_catalog';
import { providerPrefToApi } from '$lib/chat/model-registry';

export type Provider = 'anthropic' | 'google' | 'local';

// Repo selection from message text — same keyword-scan heuristic as the
// legacy endpoint. Client may also pass an explicit `target_repo`.
function detectTargetRepo(message: string, hint?: string): string {
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
	// Fork-aware fallback: companion mode → 'companion', wired → 'LogueOS-Console'.
	return appIdentity.defaultWorkspace;
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
}

export interface PreparedStreamContext {
	messages: UIMessage[];
	threadId: string;
	/**
	 * The latest user message text both paths feed to autonomous dispatch +
	 * the system prompt. This is the SPACE-JOINED, trimmed form (the original
	 * `userMessageText`), NOT the no-separator validation form used for
	 * persist/classify. Behaviour-preserving: the dispatch gates + system prompt
	 * always consumed the space-joined value.
	 */
	userText: string;
	currentTier: Tier;
	threadState: ThreadState;
	targetRepo: string;
	provider: Provider;
	resolvedModelId: string;
	useClaudeCLI: boolean;
	allowSensitive: boolean;
	systemPrompt: string;
	modelMessages: UIMessage[];
}

/**
 * Run the shared preamble both streaming paths depend on and return a context
 * object carrying every field they need. The route handler keeps the
 * body-parse + early validation returns, then calls this, then branches on
 * `useClaudeCLI`.
 */
export async function prepareStream(args: PrepareArgs): Promise<PreparedStreamContext> {
	const { messages, threadId, userText } = args;

	// Persist the operator's message + classify the conversation tier via the
	// shared chat_turn service (PR C). Mirrors the legacy /api/chat behaviour.
	persistUserTurn({ text: userText, threadId });
	const { currentTier, threadState } = classifyAndTouchThread({
		threadId,
		userText
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
	const priorTurns: UIMessage[] = getChatMessages(HOT_WINDOW, threadId)
		.filter(
			(r) => r.sender !== 'system' && typeof r.message === 'string' && r.message.trim() !== ''
		)
		.map(
			(r) =>
				({
					id: String(r.id),
					role: r.sender === 'operator' ? 'user' : 'assistant',
					parts: [{ type: 'text', text: r.message }]
				}) as UIMessage
		);
	// Drop the DB's text-only copy of the current turn(s) and use the body's
	// version instead — it preserves rich parts (e.g. image attachments) that
	// chat_messages stores only as text.
	const modelMessages: UIMessage[] = [
		...priorTurns.slice(0, Math.max(0, priorTurns.length - messages.length)),
		...messages
	];

	const targetRepo = detectTargetRepo(userText, args.targetRepoHint);

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
	const companionDefault: Provider | null = runMode.companion ? 'local' : null;
	const provider: Provider =
		args.provider ?? overrideFromState ?? tierImpliesLocal ?? companionDefault ?? 'google';

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
		{ targetRepo, currentTier, threadId, allowSensitive },
		userMessageText
	);

	return {
		messages,
		threadId,
		userText: userMessageText,
		currentTier,
		threadState,
		targetRepo,
		provider,
		resolvedModelId,
		useClaudeCLI,
		allowSensitive,
		systemPrompt,
		modelMessages
	};
}
