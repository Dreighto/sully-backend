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
import { streamText, convertToModelMessages, generateId, tool, type UIMessage } from 'ai';
import { z } from 'zod';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { addChatMessage, getChatMessages, listChatThreads } from '$lib/server/chat';
import { streamViaClaudeCLI } from '$lib/server/claude_cli_stream';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { type Tier } from '$lib/server/phase_classifier';
import { upsertThreadTier } from '$lib/server/thread_state';
import { touchLastActivity } from '$lib/server/thread_meta';
import { serverConfig, runMode, appIdentity } from '$lib/server/config';
import { getSensitiveTools } from '$lib/server/companion_tools';
import {
	ruleGate,
	valueGate,
	extractGateBlock,
	validateGate,
	GATE_INSTRUCTION
} from '$lib/server/decisionGate';
import { dispatchToWorker } from '$lib/server/companionDispatch';
import {
	persistUserTurn,
	classifyAndTouchThread,
	persistAssistantTurn
} from '$lib/server/chat_turn';
import { buildSystemPrompt } from '$lib/server/chat_prompt';
import { resolveChatModel } from '$lib/server/model_catalog';

// LogueOS-on-SDK tools — read-only operator-context fetches the LLM can call
// when answering. PR 10a shipped the first tool; PR 10c (this commit) adds
// two more high-value reads. Future PRs (10d+) layer write-tools with
// operator-approval gates (linear_create_issue, service_restart) and the
// full MCP-gateway pass-through. See task #10.
//
// `baseTools` are always safe to expose (the operator's own chat context +
// service status). The SENSITIVE tools (read_file/list_directory/web_search/
// web_fetch, in companion_tools.ts) are attached PER REQUEST and ONLY when the
// request did not arrive over the public Tailscale Funnel — see the POST
// handler. This keeps machine-read + web powers to the operator's own devices.
const baseTools = {
	list_chat_threads: tool({
		description:
			"Lists the operator's chat threads with message counts and latest activity. Use when the operator asks about their threads, history, or what conversations exist.",
		inputSchema: z.object({
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.default(10)
				.describe('How many threads to return (default 10, max 50)')
		}),
		execute: async ({ limit }: { limit?: number }) => {
			const all = listChatThreads();
			const n = Math.min(Math.max(limit ?? 10, 1), 50);
			return {
				count: all.length,
				returned: Math.min(all.length, n),
				threads: all.slice(0, n).map((t) => ({
					thread_id: t.thread_id,
					message_count: t.message_count,
					latest_ts: t.latest_ts
				}))
			};
		}
	}),
	read_thread_messages: tool({
		description:
			"Returns the most recent N messages from a specific chat thread. Use when the operator wants to recall, summarize, or refer back to a conversation — including the active thread when they ask 'what did I say earlier?' or 'summarize this thread'.",
		inputSchema: z.object({
			thread_id: z
				.string()
				.describe(
					'Thread id (use the active thread id from the system context if the operator does not specify one)'
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.default(20)
				.describe('How many recent messages to return (default 20, max 50)')
		}),
		execute: async ({ thread_id, limit }: { thread_id: string; limit?: number }) => {
			const rows = getChatMessages(Math.min(Math.max(limit ?? 20, 1), 50), thread_id);
			return {
				thread_id,
				returned: rows.length,
				messages: rows.map((m) => ({
					sender: m.sender,
					message: m.message,
					timestamp: m.timestamp
				}))
			};
		}
	}),
	get_server_status: tool({
		description:
			'Reports the live status of the operator-facing LogueOS services on this machine (Console, dispatch listener, MCP gateway). Use when the operator asks if services are up, what is running, or troubleshoots a "why did nothing happen" symptom.',
		inputSchema: z.object({}),
		execute: async () => {
			const probes: { name: string; url: string }[] = [
				{ name: 'console', url: 'http://127.0.0.1:18767/console/' },
				{ name: 'dispatch_listener', url: 'http://127.0.0.1:19100/healthz' },
				{ name: 'mcp_gateway', url: 'http://127.0.0.1:18766/mcp' }
			];
			const results = await Promise.all(
				probes.map(async (p) => {
					try {
						const r = await fetch(p.url, {
							method: 'GET',
							signal: AbortSignal.timeout(2000)
						});
						return { name: p.name, url: p.url, ok: r.status < 500, status: r.status };
					} catch (err) {
						return {
							name: p.name,
							url: p.url,
							ok: false,
							error: (err as Error).message
						};
					}
				})
			);
			return { checked_at: new Date().toISOString(), services: results };
		}
	})
};

type Provider = 'anthropic' | 'google' | 'local';

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
 *   Sonnet → API key only (billed)
 *   Opus   → API key only (billed)
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

// buildSystemPrompt: extracted to $lib/server/chat_prompt.ts (PR C).

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

// Pull the latest user message's plain-text content from a UIMessage[] —
// needed for tier classification + persistence. The SDK ships UIMessage
// with a `parts` array; only `type: "text"` parts are concatenated here.
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

	// Persist the operator's message + classify the conversation tier via the
	// shared chat_turn service (PR C). Mirrors the legacy /api/chat behaviour.
	persistUserTurn({ text: userText, threadId });
	const { currentTier, threadState } = classifyAndTouchThread({
		threadId,
		userText
	});

	const targetRepo = detectTargetRepo(userText, body.target_repo);

	// Provider preference:
	//   1. Explicit body.provider (client just chose a model)
	//   2. thread_state.provider_override (persisted via model picker)
	//   3. Default 'google' (matches legacy AGY-chat-lock UX). Operator can
	//      flip to Anthropic via picker; Anthropic-via-OAuth is free.
	const overrideFromState: Provider | null =
		threadState.provider_override === 'anthropic'
			? 'anthropic'
			: threadState.provider_override === 'gemini'
				? 'google'
				: threadState.provider_override === 'local'
					? 'local'
					: null;
	// Tier 'local' implicitly selects the local provider unless the operator
	// has explicitly overridden. Lets the existing "Local (Ollama)" model
	// picker option route through Ollama without per-thread setup.
	const tierImpliesLocal: Provider | null = currentTier === 'local' ? 'local' : null;
	// Companion mode defaults to the LOCAL provider (companion-v1) instead of
	// cloud Google — while keeping cloud models selectable via the picker.
	const companionDefault: Provider | null = runMode.companion ? 'local' : null;
	const provider: Provider =
		body.provider ?? overrideFromState ?? tierImpliesLocal ?? companionDefault ?? 'google';

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
		requestedModel: body.model
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
	const viaFunnel = request.headers.get('tailscale-funnel-request') !== null;
	const TOOLS_SECRET = process.env.COMPANION_TOOLS_KEY || '';
	const providedKey = request.headers.get('x-companion-tools-key') || '';
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
				const transcript = messages
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
						tier: currentTier
					});
				} else if (!errored) {
					upsertThreadTier(threadId, currentTier, resolvedModelId);
					touchLastActivity(threadId);
				}

				// ── Autonomous dispatch (spec §4.2). Sully decides; Full-auto fires
				// it in the background. @cc/@agy stays as an explicit override. ────
				if (gateOn && !errored) {
					const forced = ruleGate(userMessageText);
					const gate = validateGate(block);
					const vg = valueGate({ text: userMessageText, fromTool: false });
					const autonomous = gate.ok && gate.gate.escalate && vg.qualifies && !vg.forceAsk;
					if (forced.forced || autonomous) {
						const worker =
							forced.forced && forced.worker
								? forced.worker
								: gate.ok
									? gate.gate.worker
									: 'claude-code';
						const brief = gate.ok ? gate.gate.brief : userMessageText.slice(0, 200);
						const category = gate.ok ? gate.gate.category : 'code';
						const traceId = `sully-${Date.now()}`;
						const res = await dispatchToWorker({
							traceId,
							worker,
							category,
							brief,
							targetRepo,
							task: userMessageText,
							threadId
						});
						addChatMessage(
							'system',
							res.ok
								? `Sully sent this to **${worker === 'claude-code' ? 'CC' : 'AGY'}** on **${targetRepo}** — watching it now.`
								: `⚠️ Dispatch held: ${res.reason}.`,
							res.ok ? traceId : null,
							null,
							null,
							'sent',
							threadId
						);
					}
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

	// Sensitive tools (computed via `allowSensitive` above) ride along only on
	// the operator's own devices; public Funnel requests get baseTools only.
	const tools = allowSensitive ? { ...baseTools, ...getSensitiveTools() } : baseTools;

	const result = streamText({
		model: modelHandle.model,
		system: systemPrompt,
		messages: await convertToModelMessages(messages),
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
				persistAssistantTurn({
					text: finalText,
					sender: senderLabel,
					threadId,
					model: modelHandle.modelId,
					tier: currentTier
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
			if (runMode.companionDispatchEnabled) {
				const forced = ruleGate(userMessageText);
				const vg = valueGate({ text: userMessageText, fromTool: false });
				if (forced.forced || (vg.qualifies && !vg.forceAsk)) {
					const worker = forced.forced && forced.worker ? forced.worker : 'claude-code';
					const traceId = `sully-${Date.now()}`;
					const res = await dispatchToWorker({
						traceId,
						worker,
						category: 'code',
						brief: userMessageText.slice(0, 200),
						targetRepo,
						task: userMessageText,
						threadId
					});
					addChatMessage(
						'system',
						res.ok
							? `Sully sent this to **${worker === 'claude-code' ? 'CC' : 'AGY'}** on **${targetRepo}** — watching it now.`
							: `⚠️ Dispatch held: ${res.reason}.`,
						res.ok ? traceId : null,
						null,
						null,
						'sent',
						threadId
					);
				}
			}
		}
	});
};
