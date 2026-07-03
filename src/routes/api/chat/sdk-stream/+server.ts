// SDK-native streaming endpoint — Vercel AI SDK 6 / `streamText` +
// `toUIMessageStreamResponse()`. Feature-parity replacement for the legacy
// custom-SSE `/api/chat/stream` route, ready for PR 2b client cutover.
//
// PR 2b.1 (this file): the endpoint accepts the SDK 6 client shape
// (`{ messages: UIMessage[], thread, target_repo, provider?, model? }`)
// AND handles all the legacy responsibilities:
//   - persist operator message + assistant reply to chat_messages
//   - upsert chat_thread_meta + chat_thread_state
//   - classify tier from the latest user message
//   - pick provider via thread_state.provider_override OR explicit body
//   - default to Gemini for chat tier (matches legacy AGY-chat-lock UX)
//   - emit the SDK Data Stream Protocol so useChat() consumes natively
//
// The shared preamble (persist → classify → hot-window → provider/model
// resolution → CLI-vs-direct decision → tool gating → system prompt) lives in
// $lib/server/chat/stream_prepare.ts. The autonomous-dispatch decision both
// paths run after replying lives in $lib/server/chat/autonomous_dispatch.ts.
// This handler stays a thin orchestrator: parse → prepare → branch.
//
// Image requests short-circuit BEFORE the dispatch gate and the local pre-turn
// router: isImageRequest → generateImageReply streams the direct Gemini image
// model's markdown inline (restored post hybrid-brain merge, which had dropped
// it — DB rows 2136-2139). The CLI bridge also pushes a data-sully-artifact
// frame mid-reply when a SULLY_ARTIFACT sentinel promotes (restored likewise).
//
// What's intentionally NOT here yet (PR 2b.2 / 2b.3 / PR 4):
//   - multi-provider fall-forward (SDK middleware can add later)
//   - @cc / @agy dispatch routing (separate non-streaming path)
//   - slash commands (client-side intercept before send)
//   - Ollama / local routing (task #11)
//
// Auth: no app-level gate. The Tailscale Funnel + undisclosed *.ts.net
// hostname is the security boundary; the cookie gate was removed (broken on
// iOS — see hooks.server.ts). All provider credentials are server-side.
//
// Provider auth (Anthropic OAuth via Claude Max quota — FREE — is preferred
// to billed API key; Gemini API key only for now):
//   Anthropic: CLAUDE_CODE_OAUTH_TOKEN (Bearer) → LOGUEOS_ROUTING_KEY /
//              MIRU_ROUTING_KEY / ANTHROPIC_API_KEY (x-api-key fallback)
//   Google:    GEMINI_API_KEY → GOOGLE_API_KEY

import type { RequestHandler } from './$types';
import {
	streamText,
	stepCountIs,
	convertToModelMessages,
	generateId,
	type UIMessage,
	type FinishReason
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamViaClaudeCLI } from '$lib/server/claude_cli_stream';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { type Tier } from '$lib/server/phase_classifier';
import { upsertThreadTier } from '$lib/server/thread_state';
import { touchLastActivity } from '$lib/server/thread_meta';
import { getSensitiveTools } from '$lib/server/companion_tools';
import { persistAssistantTurn } from '$lib/server/chat_turn';
import { deleteChatMessage } from '$lib/server/chat';
import { expireTaskById, markSelfHandled } from '$lib/server/dispatchJobs';
import { logTaskEvent } from '$lib/server/chatActivity';
import { resolveChatModel } from '$lib/server/model_catalog';
import { baseTools } from '$lib/server/chat/base_tools';
import { systemReadTools } from '$lib/server/chat/system_read_tools';
import {
	extractAndPromoteArtifacts,
	hasLiveArtifactSignal
} from '$lib/server/chat/artifact_sentinel';
import { maybeAutoTitle } from '$lib/server/auto_title';
import { generateGeminiImage } from '$lib/server/gemini';
import { mintTeacherTraceId } from '$lib/server/artifactStore';
import { prepareStream, type Provider } from '$lib/server/chat/stream_prepare';
import { factGate } from '$lib/server/routing/factGate';
import { LOCAL_GATE_INSTRUCTION, parseEscalation } from '$lib/server/routing/local_gate';
import { logEscalation, updateEscalationCloudOutput } from '$lib/server/escalation_log';
import { preTurnRoute } from '$lib/server/routing/pre_turn_router';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import { needsFullReply } from '$lib/server/routing/turn_decision';

// Local Ollama endpoint — OpenAI-compatible interface at
// http://localhost:11434/v1. Task #11: brings the operator's eGPU into
// play once installed. Works against CPU too while waiting.
const OLLAMA_BASE_URL =
	process.env.OLLAMA_BASE_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:11434';
const OLLAMA_V1 = `${OLLAMA_BASE_URL}/v1`;

// Tier × provider model ids live in src/lib/server/model_catalog.ts (PR D).
// Routes resolve through `resolveChatModel`; no local mirror.

function getAnthropicApiKey(): string {
	return (
		process.env.LOGUEOS_ROUTING_KEY ||
		process.env.MIRU_ROUTING_KEY ||
		process.env.ANTHROPIC_API_KEY ||
		''
	);
}

function getAnthropicOAuth(): string | undefined {
	return process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined;
}

/**
 * Route auth based on the model. Anthropic's Claude Max OAuth token only
 * grants API-style access to Haiku (and a subset of legacy models). Sonnet
 * and Opus over the Max OAuth path return 429 rate_limit_error with
 * `"message":"Error"` — that's NOT a real rate limit; it's Anthropic's
 * mislabel for "wrong auth tier for this model". Verified 2026-05-27 with
 * the operator at 6% of 5h / 25% of weekly quota.
 *
 * Sealed routing (operator directive — no band-aids):
 *   Haiku  → OAuth-first (free Max quota), API-key fallback
 *   Sonnet → CLI bridge over OAuth (see `useClaudeCLI` above; never reaches
 *            this direct-API path)
 *   Opus   → CLI bridge over OAuth (same)
 *
 * This helper only runs on the direct-API path. Sonnet/Opus are intercepted
 * earlier by `useClaudeCLI` and streamed through the Claude CLI binary (the
 * authorized OAuth client), so they don't fall back to a billed API key.
 */
function getAnthropicAuthForModel(modelId: string): { authToken?: string; apiKey?: string } {
	const isHaiku = /haiku/i.test(modelId);
	const oauth = getAnthropicOAuth();
	const apiKey = getAnthropicApiKey();

	if (isHaiku && oauth) return { authToken: oauth };
	if (apiKey) return { apiKey };
	if (oauth) return { authToken: oauth }; // last-resort fallback
	return {};
}

function getGoogleKey(): string {
	return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

function pickModel(provider: Provider, tier: Tier, requestedModel?: string) {
	const modelId = resolveChatModel({ tier, provider, requestedModel });
	if (provider === 'anthropic') {
		const auth = getAnthropicAuthForModel(modelId);
		if (!auth.authToken && !auth.apiKey) {
			throw new Error(
				`Anthropic credential unavailable for ${modelId}. Sonnet/Opus require ANTHROPIC_API_KEY; Haiku also accepts CLAUDE_CODE_OAUTH_TOKEN.`
			);
		}
		return { model: createAnthropic(auth)(modelId), modelId };
	}
	if (provider === 'local') {
		// Ollama exposes an OpenAI-compatible interface; no auth required
		// (binds to localhost only — exposed via Tailscale Serve if at all).
		// Task #11 — eGPU local routing for the 5060 Ti.
		const localProvider = createOpenAICompatible({
			name: 'ollama-local',
			baseURL: OLLAMA_V1,
			apiKey: 'ollama' // placeholder, ignored by Ollama but required by SDK shape
		});
		return { model: localProvider(modelId), modelId };
	}
	const apiKey = getGoogleKey();
	if (!apiKey) throw new Error('Google credential unavailable');
	return { model: createGoogleGenerativeAI({ apiKey })(modelId), modelId };
}

// Pull the latest user message's plain-text content from a UIMessage[] —
// needed for the no-text-content validation guard below. The SDK ships
// UIMessage with a `parts` array; only `type: "text"` parts are concatenated.
function latestUserText(messages: UIMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== 'user') continue;
		const parts = m.parts || [];
		const txt = parts
			.filter((p) => p.type === 'text')
			.map((p) => (p as { type: 'text'; text: string }).text)
			.join('');
		if (txt) return txt;
	}
	return '';
}

// Orphan rollback (Stage 1). prepareTurnLifecycle persists the operator row +
// mints a 'proposed' Task BEFORE the model runs. When a turn terminates having
// emitted ZERO reply tokens AND written NO assistant row (a pre-stream
// credential 503, or a stream that errored with empty collected text), that
// operator row + proposed Task are orphaned — a lone "Hey Sully" with no reply
// (DB thread rows 1673/1674/1675). Undo BOTH, scoped to THIS turn's exact ids.
//
// Idempotent + best-effort: deleteChatMessage no-ops on an already-gone row;
// expireTaskById is guarded to a pre-dispatch state so it can't touch a task
// that dispatched. NEVER call this on a turn that emitted a token, wrote an
// assistant row, or made a dispatch/proposal — those either persist (so
// finalText/collected is non-empty) or short-circuit (D2.1 work-turn) before
// reaching any call site here.
//
// Stage 2 REUSE GUARD (`reused`): a keyed retry/regenerate re-POST REUSES the
// original operator row + Task (prepareStream returns operatorRowId/taskId of the
// pre-existing, already-answered turn). That row is NOT an orphan this turn
// created — deleting it would nuke the operator's real message and expire its
// handled Task, and retries correlate with the exact transient provider errors
// that reach these call sites. So a reused turn is NEVER rollback-eligible: bail
// out up-front. Only a freshly-persisted row (reused===false) is a true orphan.
// The guard lives inside this single chokepoint so no call site can forget it.
function rollbackOrphanTurn(operatorRowId: number, taskId: string, reused: boolean): void {
	if (reused) return;
	try {
		// Guard: only touch a row that was in fact persisted this turn.
		if (operatorRowId) deleteChatMessage(operatorRowId);
		expireTaskById(taskId);
	} catch (e) {
		console.error('[sdk-stream] orphan rollback failed', e);
	}
}

// "generate an image of X" → the direct Gemini image model, NOT a coding-worker
// dispatch. Requires a generation verb AND an image noun close together so it
// doesn't fire on "I have an image problem in my code".
const IMAGE_INTENT_RE =
	/\b(generate|create|make|draw|render|paint|design|sketch|illustrate|whip up|cook up)\b[\s\S]{0,30}\b(image|picture|photo|pic|illustration|drawing|artwork|logo|icon|portrait|wallpaper|painting)\b/i;

function isImageRequest(text: string): boolean {
	return IMAGE_INTENT_RE.test(text);
}

// Strip a worker-routing prefix ("@agy ", "dispatch agy to ") so it doesn't
// pollute the image prompt; keep the actual description.
function imagePromptFrom(text: string): string {
	return text
		.replace(/^\s*@\w+[\s,:]+/i, '')
		.replace(/^\s*dispatch\s+\w+\s+to\s+/i, '')
		.replace(/^\s*(please|hey|can you|could you)\b[\s,]*/i, '')
		.trim();
}

// Generate the image directly (~7s) and stream it back as an inline markdown
// image the app renders. Persists the reply as an 'agy' turn. Opens the stream
// immediately so the app shows a thinking row during generation.
//
// Failure semantics (Stage 1): generateGeminiImage throwing means ZERO bytes
// streamed and no assistant row written — surface an error frame (same channel
// the other stream paths use) and roll THIS turn's operator row + proposed Task
// back. `reused` rides through to persistAssistantTurn so a keyed retry of an
// image turn REPLACES the prior image reply (Stage 3a), and through
// rollbackOrphanTurn so a reused row is never rolled back (Stage 2 guard
// lives inside the chokepoint).
function generateImageReply(opts: {
	prompt: string;
	threadId: string;
	taskId: string;
	operatorRowId: number;
	reused: boolean;
}): Response {
	const { prompt, threadId, taskId, operatorRowId, reused } = opts;
	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			const messageId = generateId();
			const textId = '0';
			writer.write({ type: 'start', messageId });
			let md: string;
			try {
				const { url } = await generateGeminiImage(prompt);
				// Sanitize the alt text: [, ], and newlines would break the image
				// markdown so it never renders (a permanent failure after a paid
				// ~7s generation). Strip them; the URL stays byte-exact.
				const altText = prompt
					.slice(0, 80)
					.replace(/[\[\]\r\n]/g, ' ')
					.trim();
				md = `![${altText}](${url})`;
			} catch (e) {
				const msg = e instanceof Error ? e.message : 'unknown error';
				// Orphan rollback (Stage 1): the image model failed before a single
				// byte streamed and no assistant row exists. Undo THIS turn's operator
				// row + proposed Task, then surface a friendly error frame.
				// reused===true short-circuits inside — never nuke a reused row/task.
				rollbackOrphanTurn(operatorRowId, taskId, reused);
				writer.write({
					type: 'error',
					errorText: `Image generation failed (gemini-2.5-flash-image): ${msg.slice(0, 300)}`
				});
				writer.write({ type: 'finish', finishReason: 'error' });
				return;
			}
			const replyId = persistAssistantTurn({
				text: md,
				sender: 'agy',
				threadId,
				model: 'gemini-2.5-flash-image',
				tier: 'chat',
				taskId,
				provider: 'gemini',
				reused
			});
			// Close the turn's ledger arc as self-handled. The image short-circuit
			// never runs applyTurnDecision, so without this the pending_jobs row
			// (proposed→classified) would stall at 'classified' forever. markSelfHandled
			// is status-guarded to proposed/classified (no-op if already advanced) and
			// links the just-persisted 'agy' image reply as synthesis_message_id.
			markSelfHandled(taskId);
			logTaskEvent(taskId, 'gate_evaluated', {
				action: 'Talk',
				reason: 'image-generation',
				dispatched: false
			});
			void maybeAutoTitle(threadId);
			writer.write({ type: 'start-step' });
			writer.write({ type: 'text-start', id: textId });
			writer.write({ type: 'text-delta', id: textId, delta: md });
			writer.write({ type: 'text-end', id: textId });
			writer.write({ type: 'finish-step' });
			// Stage 1 (server-owned reply-id): emit the persisted row id on a terminal
			// data-sully-reply-id frame BEFORE finish so the client reconciles the
			// streamed reply to its stored row without polling history. Guard: only a
			// valid persisted id (>0) — never on a rolled-back / zero-token turn.
			if (typeof replyId === 'number' && replyId > 0) {
				writer.write({ type: 'data-sully-reply-id', data: { id: replyId } });
			}
			writer.write({ type: 'finish', finishReason: 'stop' });
		}
	});
	return createUIMessageStreamResponse({ stream });
}

export const POST: RequestHandler = async ({ request }) => {
	let body: {
		messages?: UIMessage[];
		thread?: string;
		target_repo?: string;
		provider?: Provider;
		model?: string;
		/** Stage 2: client-supplied per-turn id for idempotent operator-turn persistence. */
		client_turn_id?: string;
	};
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'invalid_json' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const messages = body.messages ?? [];
	if (!Array.isArray(messages) || messages.length === 0) {
		return new Response(JSON.stringify({ error: 'messages_required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const threadId =
		typeof body.thread === 'string' && body.thread.trim() ? body.thread.trim() : 'default';
	const userText = latestUserText(messages);
	if (!userText) {
		return new Response(JSON.stringify({ error: 'no_text_content' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Shared preamble: persist the operator turn, classify the tier, assemble
	// the hot window, resolve provider + model, decide CLI-vs-direct, compute
	// tool gating, and build the system prompt. Both paths source from this.
	// Stage 2: a client-supplied per-turn id makes a retry/regenerate re-POST of the
	// SAME logical turn reuse its original operator row + Task instead of minting a
	// duplicate. Additive + optional — absent → today's behaviour, byte-identical.
	const clientTurnId =
		typeof body.client_turn_id === 'string' && body.client_turn_id.trim()
			? body.client_turn_id.trim()
			: null;

	const ctx = await prepareStream({
		messages,
		threadId,
		userText,
		provider: body.provider,
		model: body.model,
		targetRepoHint: body.target_repo,
		headers: request.headers,
		clientTurnId
	});
	const {
		taskId,
		operatorRowId,
		reused,
		currentTier,
		targetRepo,
		provider,
		resolvedModelId,
		useClaudeCLI,
		allowSensitive,
		systemPrompt,
		modelMessages,
		userText: userMessageText,
		shadowDecision
	} = ctx;

	// Image generation short-circuit: route "generate an image of X" straight to
	// the direct Gemini image model (~7s) instead of the plain text model or the
	// AGY coding worker (minutes, often aborts). Runs BEFORE the D2.1 dispatch
	// gate AND the local pre-turn router, so even "@agy generate an image"
	// takes the fast path and an image ask never reaches the text model.
	if (isImageRequest(userMessageText)) {
		return generateImageReply({
			prompt: imagePromptFrom(userMessageText),
			threadId,
			taskId,
			operatorRowId,
			reused
		});
	}

	// D2.1: Classify-before-answer gate. A work turn produces NO conversational
	// reply — applyTurnDecision writes the proposal/dispatch/routing-ask and the
	// operator sees it via the 3s poll. Return a valid-but-empty UIMessage stream
	// so the SDK client closes cleanly (frontend deletes the empty placeholder).
	const decision = shadowDecision;
	if (!needsFullReply(decision)) {
		await applyTurnDecision(decision, {
			taskId,
			threadId,
			targetRepo,
			userText: userMessageText,
			reused
		});
		const stream = createUIMessageStream({
			execute: ({ writer }) => {
				const messageId = generateId();
				writer.write({ type: 'start', messageId });
				writer.write({ type: 'finish', finishReason: 'stop' });
			}
		});
		return createUIMessageStreamResponse({ stream });
	}

	// ─── CLI bridge path (Sonnet/Opus over OAuth) ────────────────────────
	if (useClaudeCLI) {
		const senderLabel = 'cc' as const;
		// D2.1: decision is now ctx.shadowDecision (deterministic). No GATE_INSTRUCTION
		// injected — the model emits a plain reply; stream + persist it directly.
		const cliSystemPrompt = systemPrompt;
		// Pre-mint the teacher artifact trace so the mid-reply data-sully-artifact
		// frame and the post-stream promote share ONE id — the live card the iOS
		// app snaps in resolves against the promoted store entry (see the
		// mintTeacherTraceId contract in artifactStore.ts).
		const artifactTrace = mintTeacherTraceId();
		const stream = createUIMessageStream({
			execute: async ({ writer }) => {
				const messageId = generateId();
				const textId = '0';
				writer.write({ type: 'start', messageId });
				writer.write({ type: 'start-step' });
				writer.write({ type: 'text-start', id: textId });

				// Flatten the conversation into a single text prompt for the
				// stateless CLI. The CLI doesn't see prior turns otherwise.
				const transcript = modelMessages
					.map((m) => {
						const role = m.role === 'assistant' ? 'assistant' : 'user';
						const text = (m.parts || [])
							.filter((p) => p.type === 'text')
							.map((p) => (p as { type: 'text'; text: string }).text)
							.join('');
						return text ? `[${role}]: ${text}` : '';
					})
					.filter(Boolean)
					.join('\n\n');

				let collected = '';
				let errored = false;
				let artifactSignaled = false;
				for await (const chunk of streamViaClaudeCLI({
					model: resolvedModelId,
					systemPrompt: cliSystemPrompt,
					userPrompt: transcript || 'hello',
					// Propagate client disconnect/abort so the CLI child is
					// killed promptly instead of running on (burning Max quota).
					signal: request.signal
				})) {
					if (chunk.type === 'text-delta') {
						collected += chunk.delta;
						// Stream each delta directly — no gate suppression needed.
						writer.write({ type: 'text-delta', id: textId, delta: chunk.delta });
						// Artifact card push: the moment the accumulating reply holds a
						// PROMOTABLE SULLY_ARTIFACT sentinel (complete header + content —
						// mirrors promote eligibility, so no ghost cards), announce the
						// pre-minted trace on the data-sully-artifact channel. The iOS app
						// decodes the frame and snaps the artifact card in mid-reply; it
						// resolves once the promote below lands under the SAME trace id.
						if (!artifactSignaled && hasLiveArtifactSignal(collected)) {
							artifactSignaled = true;
							writer.write({ type: 'data-sully-artifact', data: { traceId: artifactTrace } });
						}
					} else if (chunk.type === 'error') {
						errored = true;
						writer.write({ type: 'error', errorText: chunk.message });
					}
					// 'finish' falls through to the writer.write below
				}

				writer.write({ type: 'text-end', id: textId });
				writer.write({ type: 'finish-step' });

				// Persist the full reply — never a half/failed gen.
				// Stage 1: persist BEFORE finish so the stored row id can be captured.
				let replyId: number | undefined;
				if (collected && !errored) {
					// SULLY_ARTIFACT promote flow: strip the sentinel block(s) from the
					// persisted prose and promote them to the durable store under the
					// SAME pre-minted trace announced mid-reply above, so the live card
					// resolves. No sentinel → strippedText === collected, artifacts [].
					const { strippedText, artifacts } = extractAndPromoteArtifacts(
						collected,
						{ threadId, taskId },
						artifactTrace
					);
					replyId = persistAssistantTurn({
						text: strippedText || collected,
						sender: senderLabel,
						threadId,
						model: resolvedModelId,
						tier: currentTier,
						taskId,
						traceId: artifacts[0]?.trace_id ?? null,
						provider,
						reused
					});
				} else if (!errored) {
					upsertThreadTier(threadId, currentTier, resolvedModelId);
					touchLastActivity(threadId);
				} else if (!collected) {
					// Orphan rollback (Stage 1): the CLI bridge errored before emitting
					// a single reply token and wrote no assistant row. Undo THIS turn's
					// operator row + proposed Task. (An errored turn that DID emit text
					// falls through — a token was shown, so it is not rolled back.)
					// reused===true short-circuits inside — never nuke a reused row/task.
					rollbackOrphanTurn(operatorRowId, taskId, reused);
				}

				// Stage 1 (server-owned reply-id): persist happened above; emit the stored
				// row id on a terminal data-sully-reply-id frame BEFORE finish so the client
				// reconciles the streamed reply to its row without polling history. Guard:
				// only a valid persisted id (>0) — never on a rolled-back / zero-token turn.
				if (typeof replyId === 'number' && replyId > 0) {
					writer.write({ type: 'data-sully-reply-id', data: { id: replyId } });
				}
				writer.write({ type: 'finish', finishReason: errored ? 'error' : 'stop' });

				// D2.1: Replace maybeAutonomousDispatch with applyTurnDecision.
				// decision is ANSWER_NOW/CONVERSATIONAL_ONLY here (work turns already
				// short-circuited above) → journals Talk + markSelfHandled.
				if (!errored) {
					await applyTurnDecision(decision, {
						taskId,
						threadId,
						targetRepo,
						userText: userMessageText,
						reused
					});
				}
			},
			onError: (error: unknown) => {
				const m = (error as { message?: string })?.message || 'cli_stream_error';
				return `Claude CLI bridge: ${m}`;
			}
		});
		return createUIMessageStreamResponse({ stream });
	}

	// ─── Direct API path (Haiku, Gemini, Local) ──────────────────────────
	let modelHandle: { model: ReturnType<ReturnType<typeof createAnthropic>>; modelId: string };
	try {
		// FACT ROUTING — web-search grounding fix. A current/external-fact turn
		// needs a tool-disciplined model that TRUSTS fresh search results over its
		// own training. Small local models (e.g. companion-v1) lean on stale memory
		// and fabricate URLs even with web_search attached. So when the turn is a
		// world-fact AND web tools are actually available, route it to a strong
		// Ollama-cloud model (proxied through local Ollama with the operator's Pro
		// key) — regardless of the casual chat model picked. Casual chat is untouched.
		const factTurn = allowSensitive && factGate(userMessageText).category === 'world_fact';
		if (factTurn) {
			const factModel = process.env.COMPANION_FACT_MODEL || 'gpt-oss:120b-cloud';
			const cloud = createOpenAICompatible({
				name: 'ollama-fact',
				baseURL: OLLAMA_V1,
				apiKey: 'ollama'
			});
			modelHandle = { model: cloud(factModel), modelId: factModel };
		} else {
			modelHandle = pickModel(provider, currentTier, body.model);
		}
	} catch (err) {
		// Orphan rollback (Stage 1): pickModel threw (missing credential) — the
		// model NEVER ran, zero tokens emitted, no assistant row written. The
		// operator row + 'proposed' Task minted in prepareStream would otherwise
		// dangle. Undo BOTH before returning the 503; best-effort, never masks it.
		// reused===true short-circuits inside — never nuke a reused row/task.
		rollbackOrphanTurn(operatorRowId, taskId, reused);
		return new Response(
			JSON.stringify({ error: 'credential_unavailable', detail: (err as Error).message }),
			{ status: 503, headers: { 'Content-Type': 'application/json' } }
		);
	}

	// Sensitive tools (computed via `allowSensitive` in prepareStream) ride along
	// only on the operator's own devices; public Funnel requests get baseTools only.
	const tools = allowSensitive ? { ...baseTools, ...getSensitiveTools() } : baseTools;

	// ─── Local path ──────────────────────────────────────────────────────
	// Phase 2A: pre-turn router — skip local entirely for turns that are
	// obviously cloud-territory (debugging, multi-file analysis, live facts,
	// long threads). Saves 3–8s round-trip vs. letting local try and escalate.
	//
	// Phase 2B: progressive streaming — instead of buffering the full local
	// response (Phase 1 behaviour), accumulate only until we're confident
	// no <<<ESCALATE sentinel will appear (SENTINEL_BUFFER_CHARS), then
	// stream the rest live. Eliminates silence lag on normal local turns.
	if (provider === 'local') {
		const escalationModel = process.env.COMPANION_ESCALATION_MODEL || 'claude-sonnet-4-6-20250930';

		// ── 2A: Pre-turn routing ───────────────────────────────────────────
		const preTurn = preTurnRoute(userMessageText, messages.length);
		if (preTurn.path === 'cloud') {
			// Log the pre-turn routing decision so it feeds the same corpus as
			// model-initiated escalations. source='pre_turn' discriminates it.
			logEscalation({
				taskId,
				threadId,
				localModel: resolvedModelId,
				localOutputPreview: '',
				escalationReason: preTurn.reason,
				cloudModel: escalationModel,
				source: 'pre_turn'
			});

			// Fall through to the CLI bridge path by running the same
			// stream block inline. structuredClone(ctx) would be cleanest, but
			// to avoid branching the CLI block, we inline it here.
			const transcript = modelMessages
				.map((m) => {
					const role = m.role === 'assistant' ? 'assistant' : 'user';
					const text = (m.parts || [])
						.filter((p) => p.type === 'text')
						.map((p) => (p as { type: 'text'; text: string }).text)
						.join('');
					return text ? `[${role}]: ${text}` : '';
				})
				.filter(Boolean)
				.join('\n\n');

			const preTurnStream = createUIMessageStream({
				execute: async ({ writer }) => {
					const messageId = generateId();
					const textId = '0';
					writer.write({ type: 'start', messageId });
					writer.write({
						type: 'data-sully-routing',
						data: { handled_by: 'sdk', model: escalationModel }
					});
					writer.write({ type: 'start-step' });
					writer.write({ type: 'text-start', id: textId });

					let cloudCollected = '';
					let errored = false;
					for await (const chunk of streamViaClaudeCLI({
						model: escalationModel,
						systemPrompt,
						userPrompt: transcript || userMessageText,
						signal: request.signal
					})) {
						if (chunk.type === 'text-delta') {
							cloudCollected += chunk.delta;
							writer.write({ type: 'text-delta', id: textId, delta: chunk.delta });
						} else if (chunk.type === 'error') {
							errored = true;
							writer.write({ type: 'error', errorText: chunk.message });
						}
					}

					writer.write({ type: 'text-end', id: textId });
					writer.write({ type: 'finish-step' });

					let replyId: number | undefined;
					if (cloudCollected && !errored) {
						updateEscalationCloudOutput(taskId, cloudCollected);
						replyId = persistAssistantTurn({
							text: cloudCollected,
							sender: 'cc',
							threadId,
							model: escalationModel,
							tier: currentTier,
							taskId,
							provider: 'anthropic',
							reused
						});
					} else if (errored && !cloudCollected) {
						// Orphan rollback (Stage 1): the cloud model errored before
						// emitting a reply token and wrote no assistant row. Undo THIS
						// turn's operator row + proposed Task (only routing data-parts
						// were sent, never a reply token).
						// reused===true short-circuits inside — never nuke a reused row/task.
						rollbackOrphanTurn(operatorRowId, taskId, reused);
					}

					// Stage 1 (server-owned reply-id): persist happened above; emit the stored
					// row id on a terminal data-sully-reply-id frame BEFORE finish so the client
					// reconciles the streamed reply to its row without polling history. Guard:
					// only a valid persisted id (>0) — never on a rolled-back / zero-token turn.
					if (typeof replyId === 'number' && replyId > 0) {
						writer.write({ type: 'data-sully-reply-id', data: { id: replyId } });
					}
					writer.write({ type: 'finish', finishReason: errored ? 'error' : 'stop' });

					if (cloudCollected && !errored) {
						await applyTurnDecision(decision, {
							taskId,
							threadId,
							targetRepo,
							userText: userMessageText,
							reused
						});
					}
				},
				onError: (error: unknown) =>
					`Cloud model: ${(error as { message?: string }).message || 'stream_error'}`
			});
			return createUIMessageStreamResponse({ stream: preTurnStream });
		}

		// ── 2B: Progressive streaming with sentinel detection ─────────────
		// We need to see the first SENTINEL_BUFFER_CHARS of text before
		// deciding whether to escalate. The sentinel (`<<<ESCALATE reason="…">`)
		// is at most ~45 chars. 120 gives a comfortable margin and means any
		// normal response longer than that streams live without further delay.
		const SENTINEL_BUFFER_CHARS = 120;
		const escalationSystemPrompt = systemPrompt + '\n\n' + LOCAL_GATE_INSTRUCTION;

		const localStream = createUIMessageStream({
			execute: async ({ writer }) => {
				const messageId = generateId();
				const textId = '0';
				writer.write({ type: 'start', messageId });
				writer.write({ type: 'start-step' });
				writer.write({ type: 'text-start', id: textId });

				let sentinelBuf = '';
				let streaming = false; // true once we've started forwarding live chunks
				let fullText = ''; // complete local text for persistence
				let errored = false;

				try {
					const localResult = streamText({
						model: modelHandle.model,
						system: escalationSystemPrompt,
						messages: await convertToModelMessages(modelMessages),
						tools,
						stopWhen: ({ steps }) => steps.length >= 8
					});

					for await (const chunk of localResult.textStream) {
						fullText += chunk;

						if (streaming) {
							// Already past the buffer window — stream live.
							writer.write({ type: 'text-delta', id: textId, delta: chunk });
						} else {
							sentinelBuf += chunk;

							// Early escalation check inside the buffer window.
							if (parseEscalation(sentinelBuf)) {
								// Sentinel found — stop reading and escalate.
								// (The outer escalation block below handles it.)
								break;
							}

							if (sentinelBuf.length >= SENTINEL_BUFFER_CHARS) {
								// Buffer full, no sentinel — flush and go live.
								streaming = true;
								writer.write({ type: 'text-delta', id: textId, delta: sentinelBuf });
							}
						}
					}
				} catch (err) {
					errored = true;
					writer.write({
						type: 'error',
						errorText: `Local model: ${(err as Error).message || 'stream_error'}`
					});
					writer.write({ type: 'text-end', id: textId });
					writer.write({ type: 'finish-step' });
					writer.write({ type: 'finish', finishReason: 'error' });
					// Orphan rollback (Stage 1): the local stream threw before the model
					// produced ANY text and wrote no assistant row. Undo THIS turn's
					// operator row + proposed Task. Gated on fullText (every chunk lands
					// there before the buffer/stream split) so a turn where the model DID
					// emit tokens is never rolled back.
					// reused===true short-circuits inside — never nuke a reused row/task.
					if (!fullText) rollbackOrphanTurn(operatorRowId, taskId, reused);
					return;
				}

				// If we never crossed the buffer threshold (short response or escalation),
				// localText is whatever ended up in sentinelBuf.
				const localText = streaming ? fullText : sentinelBuf;
				const escalation = parseEscalation(localText);

				if (escalation) {
					logEscalation({
						taskId,
						threadId,
						localModel: resolvedModelId,
						localOutputPreview: localText,
						escalationReason: escalation.reason,
						cloudModel: escalationModel
					});

					writer.write({ type: 'text-delta', id: textId, delta: '_thinking harder…_\n\n' });

					const transcript = modelMessages
						.map((m) => {
							const role = m.role === 'assistant' ? 'assistant' : 'user';
							const text = (m.parts || [])
								.filter((p) => p.type === 'text')
								.map((p) => (p as { type: 'text'; text: string }).text)
								.join('');
							return text ? `[${role}]: ${text}` : '';
						})
						.filter(Boolean)
						.join('\n\n');

					let cloudCollected = '';
					for await (const chunk of streamViaClaudeCLI({
						model: escalationModel,
						systemPrompt,
						userPrompt: transcript || userMessageText,
						signal: request.signal
					})) {
						if (chunk.type === 'text-delta') {
							cloudCollected += chunk.delta;
							writer.write({ type: 'text-delta', id: textId, delta: chunk.delta });
						} else if (chunk.type === 'error') {
							errored = true;
							writer.write({ type: 'error', errorText: chunk.message });
						}
					}

					writer.write({ type: 'text-end', id: textId });
					writer.write({ type: 'finish-step' });

					let replyId: number | undefined;
					if (cloudCollected && !errored) {
						updateEscalationCloudOutput(taskId, cloudCollected);
						replyId = persistAssistantTurn({
							text: cloudCollected,
							sender: 'cc',
							threadId,
							model: escalationModel,
							tier: currentTier,
							taskId,
							provider: 'anthropic',
							reused
						});
					}

					// Stage 1 (server-owned reply-id): persist happened above; emit the stored
					// row id on a terminal data-sully-reply-id frame BEFORE finish so the client
					// reconciles the streamed reply to its row without polling history. Guard:
					// only a valid persisted id (>0) — never on a rolled-back / zero-token turn.
					if (typeof replyId === 'number' && replyId > 0) {
						writer.write({ type: 'data-sully-reply-id', data: { id: replyId } });
					}
					writer.write({ type: 'finish', finishReason: errored ? 'error' : 'stop' });

					if (cloudCollected && !errored) {
						await applyTurnDecision(decision, {
							taskId,
							threadId,
							targetRepo,
							userText: userMessageText,
							reused
						});
					}
					return;
				}

				// No escalation. If we never went live (short response), flush now.
				if (!streaming && localText) {
					writer.write({ type: 'text-delta', id: textId, delta: localText });
				}
				writer.write({ type: 'text-end', id: textId });
				writer.write({ type: 'finish-step' });

				let replyId: number | undefined;
				if (localText) {
					replyId = persistAssistantTurn({
						text: localText,
						sender: 'local',
						threadId,
						model: resolvedModelId,
						tier: currentTier,
						taskId,
						provider,
						reused
					});
				} else {
					upsertThreadTier(threadId, currentTier, resolvedModelId);
					touchLastActivity(threadId);
				}

				// Stage 1 (server-owned reply-id): persist happened above; emit the stored
				// row id on a terminal data-sully-reply-id frame BEFORE finish so the client
				// reconciles the streamed reply to its row without polling history. Guard:
				// only a valid persisted id (>0) — never on a rolled-back / zero-token turn.
				if (typeof replyId === 'number' && replyId > 0) {
					writer.write({ type: 'data-sully-reply-id', data: { id: replyId } });
				}
				writer.write({ type: 'finish', finishReason: 'stop' });

				await applyTurnDecision(decision, {
					taskId,
					threadId,
					targetRepo,
					userText: userMessageText,
					reused
				});
			},
			onError: (error: unknown) =>
				`Local model: ${(error as { message?: string }).message || 'local_stream_error'}`
		});
		return createUIMessageStreamResponse({ stream: localStream });
	}

	// Turn start — used to stamp latency_ms on the assistant row's forensics.
	const turnStartedAt = Date.now();

	// Phase 1 system-inspection tools (READ ONLY): give the DEFAULT direct path
	// (Haiku / Gemini / fact-model) the ability to look at the REAL state of the
	// LogueOS services on ROOM mid-turn — service up/enabled, recent journal
	// logs, disk/memory/port reachability — so the model reasons over ground
	// truth instead of hallucinating "everything's fine". Constrained by
	// z.enum(SERVICE_WHITELIST) at the schema layer + a whitelist re-check + no-
	// shell exec inside. Attached ONLY here — NOT on the CLI-bridge, local, or
	// image short-circuit paths (those return earlier).
	const directTools = { ...tools, ...systemReadTools };
	const systemToolsNote =
		'\n\n[System inspection] You have READ-ONLY tools to check the REAL state of the LogueOS services on this machine (ROOM): list_services, service_status, service_logs, system_health. When the operator asks whether a service is up/enabled/healthy, why one failed or restarted, or about disk/memory/reachability, CALL the relevant tool and reason over the actual result — do NOT guess or state service status from memory. Only the nine whitelisted units can be inspected; these tools cannot start, stop, or restart anything.';
	const directSystemPrompt = systemPrompt + systemToolsNote;

	// Orphan-rollback signal (Stage 1): the onError formatter below sets this when
	// the stream surfaces an error. Read in onFinish to distinguish a real
	// zero-token FAILURE (roll back the operator row + Task) from a benign empty
	// finish (advance state as before).
	let directErrored = false;
	const result = streamText({
		model: modelHandle.model,
		system: directSystemPrompt,
		messages: await convertToModelMessages(modelMessages),
		tools: directTools,
		// Cap multi-step tool loops — keeps a runaway "call → reflect → call"
		// chain from consuming Max quota / API budget. Raised to 8 so a
		// search → fetch → read → answer chain has room.
		stopWhen: stepCountIs(8)
	});

	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			// Stage 2 (server-owned reply-id): the default direct path was the ONLY reply
			// path still on result.toUIMessageStreamResponse — persist ran inside onFinish
			// AFTER the SDK had already flushed its finish frame, leaving no seam to inject a
			// pre-finish reply-id. Restructure onto createUIMessageStream like the four
			// manual-writer paths: merge the SDK UIMessageStream with sendFinish:false so every
			// start/text/tool/multi-step frame is forwarded UNCHANGED but the SDK finish is
			// suppressed. handleUIMessageStream runs our onFinish in the stream flush() — after
			// every data chunk has been read into this writer — so persist → data-sully-reply-id
			// → our own finish are guaranteed terminal, with every prior behavior intact.
			writer.merge(
				result.toUIMessageStream({
					// Suppress the SDK's own finish so we emit persist -> reply-id -> finish ourselves.
					sendFinish: false,
					originalMessages: messages,
					generateMessageId: () => generateId(),
					// Convert SDK error objects to actionable strings so the client can
					// classify them. Without this, the stream emits
					// `{"type":"error","errorText":"Failed after 3 attempts. Last error: Error"}`
					// for everything — operator can't tell rate-limit from outage from auth.
					// Audit 2026-05-27 caught Sonnet rate_limit_error surfacing as "Error".
					//
					// AI_RetryError wraps the final AI_APICallError; the upstream HTTP
					// response body lives on `errors[last].responseBody`. Walk the chain
					// to find it.
					onError: (error: unknown) => {
						// Mark the turn errored so onFinish can roll back an empty-output orphan.
						// Runs before onFinish (error chunk is processed before stream flush).
						directErrored = true;
						type ApiCallError = {
							message?: string;
							responseBody?: string;
							statusCode?: number;
							url?: string;
						};
						type RetryError = ApiCallError & {
							errors?: ApiCallError[];
							lastError?: ApiCallError;
							cause?: ApiCallError;
						};
						const err = error as RetryError;
						// Surface the deepest API error we can find.
						const apiErr: ApiCallError =
							(err.errors && err.errors.length ? err.errors[err.errors.length - 1] : undefined) ??
							err.lastError ??
							err.cause ??
							err;

						const body = apiErr.responseBody;
						if (body) {
							try {
								const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } };
								if (parsed.error?.type) {
									const t = parsed.error.type;
									const m = parsed.error.message;
									if (t === 'rate_limit_error') {
										return `Rate limited on ${modelHandle.modelId}. Wait ~30s or switch model (Haiku, Gemini, Local).`;
									}
									if (t === 'invalid_request_error') {
										return `Invalid request to ${modelHandle.modelId}: ${m || t}`;
									}
									if (t === 'authentication_error' || t === 'permission_error') {
										return `Auth failed for ${modelHandle.modelId} (${t}). Token expired or lacks access. ${m || ''}`;
									}
									if (t === 'not_found_error') {
										return `Model not found: ${modelHandle.modelId}. ${m || ''}`;
									}
									if (t === 'overloaded_error') {
										return `Provider overloaded (${modelHandle.modelId}). Try again in a moment or switch model.`;
									}
									return `${t}${m ? ': ' + m : ''} (${modelHandle.modelId})`;
								}
							} catch {
								/* fall through */
							}
						}
						if (apiErr.statusCode) {
							return `HTTP ${apiErr.statusCode} from ${modelHandle.modelId}: ${apiErr.message || 'no detail'}`;
						}
						return (
							apiErr.message || (err as { message?: string }).message || 'unknown_stream_error'
						);
					},
					onFinish: async ({ responseMessage }) => {
						// The destructured `finishReason` param is PERMANENTLY undefined on this
						// path: sendFinish:false suppresses the SDK's UI finish chunk before it
						// reaches processUIMessageStream, and state.finishReason (createStreamingUIMessageState)
						// has no default — its sole assignment reads that now-suppressed chunk. Source
						// the real reason from result.finishReason (a PromiseLike<FinishReason>, resolved
						// from the model output — unaffected by sendFinish) so the rollback guard can fire
						// on an errored zero-text turn AND our finish frames carry the model's real reason
						// (byte-parity with the finish toUIMessageStreamResponse used to emit).
						// result.finishReason REJECTS (NoOutputGeneratedError) on a zero-step total
						// failure in ai@6 — the dominant error case (retry-exhausted / rate-limit /
						// auth / overloaded). Guard so a rejection cannot skip the Stage-1 rollback
						// below: on rejection treat the turn as errored.
						let finalReason: FinishReason | undefined;
						try {
							finalReason = await result.finishReason;
						} catch {
							finalReason = 'error';
						}

						// Concatenate every text part of the response into a single string
						// for the chat_messages row. Matches the legacy `addChatMessage`
						// call shape for backwards compatibility with existing readers.
						const parts = responseMessage.parts || [];
						const replyText = parts
							.filter((p) => p.type === 'text')
							.map((p) => (p as { type: 'text'; text: string }).text)
							.join('');

						// Capture tool errors that fired mid-stream. The streaming UI shows
						// these as ephemeral chips that vanish when sdkChat.messages resets,
						// so without persisting them here the operator never finds out a
						// tool failed silently. Audit 2026-05-27.
						const toolErrors = parts
							.filter((p) => {
								const t = p as { type?: string; state?: string };
								return t.type?.startsWith('tool-') && t.state === 'output-error';
							})
							.map((p) => {
								const t = p as { type?: string; errorText?: string };
								return `⚠️ Tool '${t.type?.replace(/^tool-/, '') ?? 'unknown'}' failed: ${
									t.errorText ?? 'unknown error'
								}`;
							});

						const finalText =
							toolErrors.length > 0
								? [replyText, ...toolErrors].filter(Boolean).join('\n\n')
								: replyText;

						// Stage 2: capture the persisted chat_messages.id so it can be emitted on a
						// terminal data-sully-reply-id frame BEFORE our finish (below). Undefined on a
						// rolled-back / zero-token turn → no frame, matching the other four paths.
						let replyId: number | undefined;
						if (finalText) {
							const senderLabel: 'cc' | 'agy' | 'local' = provider === 'anthropic' ? 'cc' : 'agy'; // 'local' path returns early above
							// Best-effort token capture — result.usage is resolved by onFinish.
							// Never block or throw on it; forensic columns are nullable.
							let promptTokens: number | null = null;
							let completionTokens: number | null = null;
							try {
								const usage = await result.usage;
								promptTokens = usage?.inputTokens ?? null;
								completionTokens = usage?.outputTokens ?? null;
							} catch {
								/* usage unavailable — leave null */
							}
							replyId = persistAssistantTurn({
								text: finalText,
								sender: senderLabel,
								threadId,
								model: modelHandle.modelId,
								tier: currentTier,
								taskId,
								provider,
								promptTokens,
								completionTokens,
								latencyMs: Date.now() - turnStartedAt,
								error: toolErrors.length > 0 ? toolErrors.join(' | ').slice(0, 500) : null,
								reused
							});
						} else if (directErrored || finalReason === 'error') {
							// Orphan rollback (Stage 1): the stream errored with ZERO reply text
							// and wrote no assistant row. The operator row + 'proposed' Task minted
							// in prepareStream would otherwise dangle. Undo BOTH, scoped to this
							// turn, and SKIP the dispatch decision below (an errored turn makes no
							// routing decision). A turn that emitted a token lands in the finalText
							// branch above and is never rolled back.
							// reused===true short-circuits inside — never nuke a reused row/task.
							rollbackOrphanTurn(operatorRowId, taskId, reused);
							// Stage 2: the classified error frame was already forwarded by the merged
							// SDK stream (onError above). Close with our OWN finish (sendFinish was
							// suppressed) carrying the model's finishReason — byte-parity with the
							// finish toUIMessageStreamResponse used to emit — then bail: no reply-id,
							// no dispatch decision on an errored turn.
							writer.write({ type: 'finish', finishReason: finalReason });
							return;
						} else {
							// No reply text but the SDK call finished cleanly — advance state so
							// the picker chip can show "Claude Haiku 4.5" instead of "Auto".
							upsertThreadTier(threadId, currentTier, modelHandle.modelId);
							touchLastActivity(threadId);
						}

						// Stage 2 (server-owned reply-id): persist happened above; emit the stored
						// row id on a terminal data-sully-reply-id frame BEFORE finish so the client
						// reconciles the streamed reply to its row without polling history. Guard:
						// only a valid persisted id (>0) — never on a rolled-back / zero-token turn.
						if (typeof replyId === 'number' && replyId > 0) {
							writer.write({ type: 'data-sully-reply-id', data: { id: replyId } });
						}
						// Suppressed-SDK finish: emit our own terminal finish carrying the model's
						// finishReason (byte-parity with the frame toUIMessageStreamResponse sent).
						writer.write({ type: 'finish', finishReason: finalReason });

						// D2.1: Replace maybeAutonomousDispatch with applyTurnDecision.
						// decision is ANSWER_NOW/CONVERSATIONAL_ONLY here (work turns already
						// short-circuited above) → journals Talk + markSelfHandled.
						// FIRE-AND-FORGET: same pattern as before — avoids coupling stream close
						// to the dispatch listener's roundtrip. Observable via next pollMessages.
						void applyTurnDecision(decision, {
							taskId,
							threadId,
							targetRepo,
							userText: userMessageText,
							reused
						}).catch((e) => {
							console.error('[sdk-stream] autonomous-dispatch failed', e);
						});
					}
				})
			);
		}
	});
	return createUIMessageStreamResponse({ stream });
};
