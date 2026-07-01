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
// What's intentionally NOT here yet (PR 2b.2 / 2b.3 / PR 4):
//   - multi-provider fall-forward (SDK middleware can add later)
//   - image-gen mode (separate dispatch path)
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
import { streamText, convertToModelMessages, generateId, type UIMessage } from 'ai';
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
import { expireTaskById } from '$lib/server/dispatchJobs';
import { resolveChatModel } from '$lib/server/model_catalog';
import { baseTools } from '$lib/server/chat/base_tools';
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
function rollbackOrphanTurn(operatorRowId: number, taskId: string): void {
	try {
		// Guard: only touch a row that was in fact persisted this turn.
		if (operatorRowId) deleteChatMessage(operatorRowId);
		expireTaskById(taskId);
	} catch (e) {
		console.error('[sdk-stream] orphan rollback failed', e);
	}
}

export const POST: RequestHandler = async ({ request }) => {
	let body: {
		messages?: UIMessage[];
		thread?: string;
		target_repo?: string;
		provider?: Provider;
		model?: string;
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
	const ctx = await prepareStream({
		messages,
		threadId,
		userText,
		provider: body.provider,
		model: body.model,
		targetRepoHint: body.target_repo,
		headers: request.headers
	});
	const {
		taskId,
		operatorRowId,
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

	// D2.1: Classify-before-answer gate. A work turn produces NO conversational
	// reply — applyTurnDecision writes the proposal/dispatch/routing-ask and the
	// operator sees it via the 3s poll. Return a valid-but-empty UIMessage stream
	// so the SDK client closes cleanly (frontend deletes the empty placeholder).
	const decision = shadowDecision;
	if (!needsFullReply(decision)) {
		await applyTurnDecision(decision, { taskId, threadId, targetRepo, userText: userMessageText });
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
					} else if (chunk.type === 'error') {
						errored = true;
						writer.write({ type: 'error', errorText: chunk.message });
					}
					// 'finish' falls through to the writer.write below
				}

				writer.write({ type: 'text-end', id: textId });
				writer.write({ type: 'finish-step' });
				writer.write({ type: 'finish', finishReason: errored ? 'error' : 'stop' });

				// Persist the full reply — never a half/failed gen.
				if (collected && !errored) {
					persistAssistantTurn({
						text: collected,
						sender: senderLabel,
						threadId,
						model: resolvedModelId,
						tier: currentTier,
						taskId,
						provider
					});
				} else if (!errored) {
					upsertThreadTier(threadId, currentTier, resolvedModelId);
					touchLastActivity(threadId);
				} else if (!collected) {
					// Orphan rollback (Stage 1): the CLI bridge errored before emitting
					// a single reply token and wrote no assistant row. Undo THIS turn's
					// operator row + proposed Task. (An errored turn that DID emit text
					// falls through — a token was shown, so it is not rolled back.)
					rollbackOrphanTurn(operatorRowId, taskId);
				}

				// D2.1: Replace maybeAutonomousDispatch with applyTurnDecision.
				// decision is ANSWER_NOW/CONVERSATIONAL_ONLY here (work turns already
				// short-circuited above) → journals Talk + markSelfHandled.
				if (!errored) {
					await applyTurnDecision(decision, {
						taskId,
						threadId,
						targetRepo,
						userText: userMessageText
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
		rollbackOrphanTurn(operatorRowId, taskId);
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
					writer.write({ type: 'finish', finishReason: errored ? 'error' : 'stop' });

					if (cloudCollected && !errored) {
						updateEscalationCloudOutput(taskId, cloudCollected);
						persistAssistantTurn({
							text: cloudCollected,
							sender: 'cc',
							threadId,
							model: escalationModel,
							tier: currentTier,
							taskId,
							provider: 'anthropic'
						});
						await applyTurnDecision(decision, {
							taskId,
							threadId,
							targetRepo,
							userText: userMessageText
						});
					} else if (errored && !cloudCollected) {
						// Orphan rollback (Stage 1): the cloud model errored before
						// emitting a reply token and wrote no assistant row. Undo THIS
						// turn's operator row + proposed Task (only routing data-parts
						// were sent, never a reply token).
						rollbackOrphanTurn(operatorRowId, taskId);
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
					if (!fullText) rollbackOrphanTurn(operatorRowId, taskId);
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
					writer.write({ type: 'finish', finishReason: errored ? 'error' : 'stop' });

					if (cloudCollected && !errored) {
						updateEscalationCloudOutput(taskId, cloudCollected);
						persistAssistantTurn({
							text: cloudCollected,
							sender: 'cc',
							threadId,
							model: escalationModel,
							tier: currentTier,
							taskId,
							provider: 'anthropic'
						});
						await applyTurnDecision(decision, {
							taskId,
							threadId,
							targetRepo,
							userText: userMessageText
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
				writer.write({ type: 'finish', finishReason: 'stop' });

				if (localText) {
					persistAssistantTurn({
						text: localText,
						sender: 'local',
						threadId,
						model: resolvedModelId,
						tier: currentTier,
						taskId,
						provider
					});
				} else {
					upsertThreadTier(threadId, currentTier, resolvedModelId);
					touchLastActivity(threadId);
				}
				await applyTurnDecision(decision, {
					taskId,
					threadId,
					targetRepo,
					userText: userMessageText
				});
			},
			onError: (error: unknown) =>
				`Local model: ${(error as { message?: string }).message || 'local_stream_error'}`
		});
		return createUIMessageStreamResponse({ stream: localStream });
	}

	// Turn start — used to stamp latency_ms on the assistant row's forensics.
	const turnStartedAt = Date.now();
	// Orphan-rollback signal (Stage 1): the onError formatter below sets this when
	// the stream surfaces an error. Read in onFinish to distinguish a real
	// zero-token FAILURE (roll back the operator row + Task) from a benign empty
	// finish (advance state as before).
	let directErrored = false;
	const result = streamText({
		model: modelHandle.model,
		system: systemPrompt,
		messages: await convertToModelMessages(modelMessages),
		tools,
		// Cap multi-step tool loops — keeps a runaway "call → reflect → call"
		// chain from consuming Max quota / API budget. Raised to 8 so a
		// search → fetch → read → answer chain has room.
		stopWhen: ({ steps }) => steps.length >= 8
	});

	return result.toUIMessageStreamResponse({
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
			return apiErr.message || (err as { message?: string }).message || 'unknown_stream_error';
		},
		onFinish: async ({ responseMessage, finishReason }) => {
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
				toolErrors.length > 0 ? [replyText, ...toolErrors].filter(Boolean).join('\n\n') : replyText;

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
				persistAssistantTurn({
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
					error: toolErrors.length > 0 ? toolErrors.join(' | ').slice(0, 500) : null
				});
			} else if (directErrored || finishReason === 'error') {
				// Orphan rollback (Stage 1): the stream errored with ZERO reply text
				// and wrote no assistant row. The operator row + 'proposed' Task minted
				// in prepareStream would otherwise dangle. Undo BOTH, scoped to this
				// turn, and SKIP the dispatch decision below (an errored turn makes no
				// routing decision). A turn that emitted a token lands in the finalText
				// branch above and is never rolled back.
				rollbackOrphanTurn(operatorRowId, taskId);
				return;
			} else {
				// No reply text but the SDK call finished cleanly — advance state so
				// the picker chip can show "Claude Haiku 4.5" instead of "Auto".
				upsertThreadTier(threadId, currentTier, modelHandle.modelId);
				touchLastActivity(threadId);
			}

			// D2.1: Replace maybeAutonomousDispatch with applyTurnDecision.
			// decision is ANSWER_NOW/CONVERSATIONAL_ONLY here (work turns already
			// short-circuited above) → journals Talk + markSelfHandled.
			// FIRE-AND-FORGET: same pattern as before — avoids coupling stream close
			// to the dispatch listener's roundtrip. Observable via next pollMessages.
			void applyTurnDecision(decision, {
				taskId,
				threadId,
				targetRepo,
				userText: userMessageText
			}).catch((e) => {
				console.error('[sdk-stream] autonomous-dispatch failed', e);
			});
		}
	});
};
