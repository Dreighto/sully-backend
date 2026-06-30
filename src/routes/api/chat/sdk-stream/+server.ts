// SDK-native streaming chat endpoint — Vercel AI SDK 6 / streamText, wrapped in a
// createUIMessageStream writer so the server can push custom data events mid-reply
// (data-sully-artifact for the Claude-style artifact card; data-sully-routing on the
// CLI bridge). THE chat path the iOS app uses.
//
// Accepts { messages: UIMessage[], thread, target_repo, provider?, model? } and:
//   - persist operator message + assistant reply to chat_messages
//   - upsert chat_thread_meta + chat_thread_state, classify tier from latest user msg
//   - pick provider (thread_state override OR body), default Gemini for chat tier
//   - short-circuit image requests to the direct Gemini image model (isImageRequest)
//   - run the dispatch decision after replying (applyTurnDecision + SULLY_GATE escalation)
//   - emit the SDK Data Stream Protocol so useChat() consumes natively
//
// Shared preamble (persist → classify → hot-window → provider/model → CLI-vs-direct →
// tool gating → system prompt) lives in $lib/server/chat/stream_prepare.ts; the
// dispatch decision in $lib/server/chat/autonomous_dispatch.ts. Thin orchestrator:
// parse → prepare → branch (image short-circuit / CLI bridge / streamText).
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
import { logEscalation } from '$lib/server/escalation_telemetry';
import { resolveChatModel } from '$lib/server/model_catalog';
import { baseTools } from '$lib/server/chat/base_tools';
import { extractAndPromoteArtifacts } from '$lib/server/chat/artifact_sentinel';
import { maybeAutoTitle } from '$lib/server/auto_title';
import { extractGateBlock, validateGate } from '$lib/server/decisionGate';
import type { TurnDecision } from '$lib/server/routing/turn_decision';
import { generateGeminiImage } from '$lib/server/gemini';
import { mintTeacherTraceId } from '$lib/server/artifactStore';
import { prepareStream, type Provider } from '$lib/server/chat/stream_prepare';
import { factGate } from '$lib/server/routing/factGate';
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

// Pull the teacher's SULLY_GATE self-assessment out of the reply: strip the block
// from the displayed prose, and if it validates with escalate:true, return a
// DISPATCH decision that OVERRIDES the deterministic decision (the teacher raising
// its hand to send a codable task to a worker). Otherwise keep the base decision.
function applyGateEscalation(
	replyText: string,
	baseDecision: TurnDecision
): { visible: string; decision: TurnDecision } {
	const { visible, block } = extractGateBlock(replyText);
	const gate = validateGate(block);
	if (gate.ok && gate.gate.escalate) {
		return {
			visible,
			decision: {
				kind: 'DISPATCH',
				worker: gate.gate.worker,
				category: gate.gate.category,
				brief: gate.gate.brief,
				reason: `gate: ${gate.gate.brief}`
			}
		};
	}
	return { visible, decision: baseDecision };
}

async function finalizeReply(opts: {
	rawText: string;
	decision: TurnDecision;
	threadId: string;
	taskId: string;
	targetRepo: string;
	userText: string;
	sender: 'cc' | 'agy' | 'local';
	model: string;
	tier: Tier;
	provider: Provider;
	forcedTraceId?: string;
	promptTokens?: number | null;
	completionTokens?: number | null;
	latencyMs?: number | null;
	error?: string | null;
}): Promise<TurnDecision> {
	let effectiveDecision = opts.decision;
	if (opts.rawText) {
		const { strippedText, artifacts } = extractAndPromoteArtifacts(
			opts.rawText,
			{ threadId: opts.threadId, taskId: opts.taskId ?? undefined },
			opts.forcedTraceId
		);
		const gateResult = applyGateEscalation(strippedText, opts.decision);
		effectiveDecision = gateResult.decision;
		persistAssistantTurn({
			text: gateResult.visible || strippedText || opts.rawText,
			sender: opts.sender,
			threadId: opts.threadId,
			model: opts.model,
			tier: opts.tier,
			taskId: opts.taskId ?? undefined,
			traceId: artifacts[0]?.trace_id ?? null,
			provider: opts.provider,
			promptTokens: opts.promptTokens ?? null,
			completionTokens: opts.completionTokens ?? null,
			latencyMs: opts.latencyMs ?? null,
			error: opts.error ?? null
		});
		void maybeAutoTitle(opts.threadId);
	} else {
		upsertThreadTier(opts.threadId, opts.tier, opts.model);
		touchLastActivity(opts.threadId);
	}

	await applyTurnDecision(effectiveDecision, {
		taskId: opts.taskId,
		threadId: opts.threadId,
		targetRepo: opts.targetRepo,
		userText: opts.userText
	});
	return effectiveDecision;
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
function generateImageReply(opts: {
	prompt: string;
	threadId: string;
	taskId: string | null;
}): Response {
	const { prompt, threadId, taskId } = opts;
	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			const messageId = generateId();
			const textId = '0';
			writer.write({ type: 'start', messageId });
			let md: string;
			try {
				const { url } = await generateGeminiImage(prompt);
				md = `![${prompt.slice(0, 80)}](${url})`;
			} catch (e) {
				const msg = e instanceof Error ? e.message : 'unknown error';
				md = `⚠️ No image generated. ${msg.slice(0, 300)}`;
			}
			persistAssistantTurn({
				text: md,
				sender: 'agy',
				threadId,
				model: 'gemini-2.5-flash-image',
				tier: 'chat',
				taskId: taskId ?? undefined,
				provider: 'gemini'
			});
			void maybeAutoTitle(threadId);
			writer.write({ type: 'start-step' });
			writer.write({ type: 'text-start', id: textId });
			writer.write({ type: 'text-delta', id: textId, delta: md });
			writer.write({ type: 'text-end', id: textId });
			writer.write({ type: 'finish-step' });
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
		/** True when the reply will be SPOKEN aloud — dictation/voice turns.
		 * Forwarded to buildSystemPrompt as a voice-mode addendum. */
		spoken?: boolean;
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
		headers: request.headers,
		spoken: body.spoken === true
	});
	const {
		taskId,
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
	// the direct Gemini image model (~7s) instead of the AGY coding worker
	// (minutes, often aborts). Runs BEFORE the dispatch gate, so even
	// "@agy generate an image" takes the fast path.
	if (isImageRequest(userMessageText)) {
		return generateImageReply({
			prompt: imagePromptFrom(userMessageText),
			threadId,
			taskId
		});
	}

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
		const escalationStartedAt = Date.now();
		const stream = createUIMessageStream({
			execute: async ({ writer }) => {
				const messageId = generateId();
				const textId = '0';
				writer.write({ type: 'start', messageId });
				// Specialist lane signal — Sonnet/Opus via CLI bridge IS the SDK
				// escalation path. Client uses this to flip the model-pill +
				// voice-orb chrome to the Warm Sand accent. Emitted BEFORE any
				// text-delta so the UI flips before the reply starts landing.
				//
				// Uses the `data-${string}` custom channel that the Vercel AI SDK
				// stream protocol reserves for app-specific metadata — clients
				// that don't know the type can safely ignore. iOS UIPart enum
				// has an `.unknown(type:)` fallback so old builds won't crash.
				writer.write({
					type: 'data-sully-routing',
					data: { handled_by: 'sdk', model: resolvedModelId }
				});
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

				// Specialist-lane telemetry — append-only escalation corpus.
				// Captures the prompt/reply pair plus latency so the next pass
				// (model-selection learner / Hermes shadow) can reason about
				// the heavy-lane firing without touching chat_messages.
				logEscalation({
					at: new Date().toISOString(),
					thread_id: threadId,
					task_id: taskId ?? null,
					user_prompt: userMessageText,
					system_prompt_head: cliSystemPrompt.slice(0, 800),
					provider,
					model: resolvedModelId,
					current_tier: currentTier,
					target_repo: targetRepo,
					reply_text: collected,
					latency_ms: Date.now() - escalationStartedAt,
					error: errored ? 'cli_stream_error' : undefined
				});

				if (!errored) {
					// Persist the full reply and run the (possibly gate-escalated)
					// decision: DISPATCH a worker, PROPOSE, or journal Talk + markSelfHandled.
					await finalizeReply({
						rawText: collected,
						decision,
						threadId,
						taskId,
						targetRepo,
						userText: userMessageText,
						sender: senderLabel,
						model: resolvedModelId,
						tier: currentTier,
						provider
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
		return new Response(
			JSON.stringify({ error: 'credential_unavailable', detail: (err as Error).message }),
			{ status: 503, headers: { 'Content-Type': 'application/json' } }
		);
	}

	// Sensitive tools (computed via `allowSensitive` in prepareStream) ride along
	// only on the operator's own devices; public Funnel requests get baseTools only.
	const tools = allowSensitive ? { ...baseTools, ...getSensitiveTools() } : baseTools;

	// Turn start — used to stamp latency_ms on the assistant row's forensics.
	const turnStartedAt = Date.now();
	const artifactTrace = mintTeacherTraceId();
	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			let artifactAcc = '';
			let artifactSignaled = false;
			const result = streamText({
				model: modelHandle.model,
				system: systemPrompt,
				messages: await convertToModelMessages(modelMessages),
				tools,
				// Cap multi-step tool loops — keeps a runaway "call → reflect → call"
				// chain from consuming Max quota / API budget. Raised to 8 so a
				// search → fetch → read → answer chain has room.
				stopWhen: ({ steps }) => steps.length >= 8,
				onChunk: ({ chunk }) => {
					const ck = chunk as { type?: string; text?: string; textDelta?: string; delta?: string };
					if (ck.type === 'text-delta') {
						artifactAcc += ck.text ?? ck.textDelta ?? ck.delta ?? '';
						if (!artifactSignaled && artifactAcc.includes('<<<SULLY_ARTIFACT')) {
							artifactSignaled = true;
							writer.write({ type: 'data-sully-artifact', data: { traceId: artifactTrace } });
						}
					}
				}
			});

			writer.merge(
				result.toUIMessageStream({
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

						const rawFinalText =
							toolErrors.length > 0
								? [replyText, ...toolErrors].filter(Boolean).join('\n\n')
								: replyText;
						const senderLabel: 'cc' | 'agy' | 'local' =
							provider === 'anthropic' ? 'cc' : provider === 'local' ? 'local' : 'agy';
						// Best-effort token capture — result.usage is resolved by onFinish.
						// Never block or throw on it; forensic columns are nullable.
						let promptTokens: number | null = null;
						let completionTokens: number | null = null;
						if (rawFinalText) {
							try {
								const usage = await result.usage;
								promptTokens = usage?.inputTokens ?? null;
								completionTokens = usage?.outputTokens ?? null;
							} catch {
								/* usage unavailable — leave null */
							}
						}

						// FIRE-AND-FORGET: same pattern as before — avoids coupling stream close
						// to the dispatch listener's roundtrip. Observable via next pollMessages.
						void finalizeReply({
							rawText: rawFinalText,
							decision,
							threadId,
							taskId,
							targetRepo,
							userText: userMessageText,
							sender: senderLabel,
							model: modelHandle.modelId,
							tier: currentTier,
							provider,
							forcedTraceId: artifactTrace,
							promptTokens,
							completionTokens,
							latencyMs: rawFinalText ? Date.now() - turnStartedAt : null,
							error: toolErrors.length > 0 ? toolErrors.join(' | ').slice(0, 500) : null
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
