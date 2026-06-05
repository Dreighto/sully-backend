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
import { runMode } from '$lib/server/config';
import { getSensitiveTools } from '$lib/server/companion_tools';
import { extractGateBlock, GATE_INSTRUCTION } from '$lib/server/decisionGate';
import { persistAssistantTurn } from '$lib/server/chat_turn';
import { resolveChatModel } from '$lib/server/model_catalog';
import { baseTools } from '$lib/server/chat/base_tools';
import { prepareStream, type Provider } from '$lib/server/chat/stream_prepare';
import { maybeAutonomousDispatch } from '$lib/server/chat/autonomous_dispatch';

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
		currentTier,
		targetRepo,
		provider,
		resolvedModelId,
		useClaudeCLI,
		allowSensitive,
		systemPrompt,
		modelMessages,
		userText: userMessageText,
		mutationGate
	} = ctx;

	// ─── CLI bridge path (Sonnet/Opus over OAuth) ────────────────────────
	if (useClaudeCLI) {
		const senderLabel = 'cc' as const;
		// Autonomous dispatch gate (spec §4.2): when the companion dispatcher is
		// on, the teacher (Opus) appends a hidden self-assessment block to its
		// reply; we strip it and act on it. Sully decides — no @cc command needed.
		const gateOn = runMode.companionDispatchEnabled;
		const cliSystemPrompt = gateOn ? `${systemPrompt}\n\n${GATE_INSTRUCTION}` : systemPrompt;
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
				let written = 0;
				let errored = false;
				const SENT = '<<<SULLY_GATE';
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
						// Suppress the hidden <<<SULLY_GATE ...>>> self-assessment from
						// the operator's view: emit up to the sentinel, or hold back a
						// sentinel-length tail so a partial marker never flashes.
						const sentIdx = collected.indexOf(SENT);
						const safeEnd =
							sentIdx >= 0 ? sentIdx : Math.max(written, collected.length - SENT.length);
						if (safeEnd > written) {
							writer.write({
								type: 'text-delta',
								id: textId,
								delta: collected.slice(written, safeEnd)
							});
							written = safeEnd;
						}
					} else if (chunk.type === 'error') {
						errored = true;
						writer.write({ type: 'error', errorText: chunk.message });
					}
					// 'finish' falls through to the writer.write below
				}

				// Split the operator-visible reply from the hidden self-assessment.
				const { visible, block } = extractGateBlock(collected);
				// No gate block → flush the held-back tail (it was plain text).
				if (block === null && collected.length > written) {
					writer.write({ type: 'text-delta', id: textId, delta: collected.slice(written) });
				}

				writer.write({ type: 'text-end', id: textId });
				writer.write({ type: 'finish-step' });
				writer.write({ type: 'finish', finishReason: errored ? 'error' : 'stop' });

				// Persist the gate-stripped visible reply — never a half/failed gen.
				if (visible && !errored) {
					persistAssistantTurn({
						text: visible,
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
				}

				// ── Autonomous dispatch (spec §4.2). Sully decides; Full-auto fires
				// it in the background. @cc/@agy stays as an explicit override. The
				// CLI path passes the extracted gate block so the teacher's
				// self-assessment steers the decision. ────
				if (!errored) {
					await maybeAutonomousDispatch({
						userText: userMessageText,
						targetRepo,
						threadId,
						gateBlock: block,
						taskId,
						tier: currentTier,
						mutationGate
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
		modelHandle = pickModel(provider, currentTier, body.model);
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

			const finalText =
				toolErrors.length > 0 ? [replyText, ...toolErrors].filter(Boolean).join('\n\n') : replyText;

			if (finalText) {
				const senderLabel: 'cc' | 'agy' | 'local' =
					provider === 'anthropic' ? 'cc' : provider === 'local' ? 'local' : 'agy';
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
			} else {
				// No reply text but the SDK call still finished — advance state so
				// the picker chip can show "Claude Haiku 4.5" instead of "Auto".
				upsertThreadTier(threadId, currentTier, modelHandle.modelId);
				touchLastActivity(threadId);
			}

			// ── Autonomous dispatch on the DIRECT/LOCAL path (spec §4.2) ──────────
			// The CLI-bridge branch gates via the teacher's hidden self-assessment
			// block, but the companion's DEFAULT reply model is the local one, which
			// runs HERE. Without this, Sully never dispatches in normal use. No gate
			// block on this path (it can't be cleanly stripped from streamText's
			// output); the deterministic gates decide: ruleGate (@cc/@agy override) +
			// valueGate (file/code/repo/long-imperative signals).
			//
			// FIRE-AND-FORGET: the AI SDK keeps the SSE stream open until this
			// onFinish resolves (its TransformStream flush awaits callOnFinish).
			// Awaiting maybeAutonomousDispatch coupled stream close to the dispatch
			// listener's roundtrip, which made the composer pulse-fade linger for
			// seconds after the last token rendered. Same fire-and-forget pattern
			// as maybeUpdateThreadSummary in chat_turn.ts:95. Dispatch results are
			// observable via the next pollMessages tick.
			void maybeAutonomousDispatch({
				userText: userMessageText,
				targetRepo,
				threadId,
				taskId,
				tier: currentTier,
				mutationGate
			}).catch((e) => {
				console.error('[sdk-stream] autonomous-dispatch failed', e);
			});
		}
	});
};
