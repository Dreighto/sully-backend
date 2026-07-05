import {
	convertToModelMessages,
	extractReasoningMiddleware,
	generateId,
	stepCountIs,
	streamText,
	wrapLanguageModel,
	type FinishReason,
	type ToolSet,
	type UIMessageChunk
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Tier } from '$lib/server/phase_classifier';
import type { PreparedStreamContext, Provider } from '$lib/server/chat/stream_prepare';
import { resolveChatModel } from '$lib/server/model_catalog';
import { persistAssistantTurn } from '$lib/server/chat_turn';
import { addTokenUsage, getTokenUsage } from '$lib/server/thread_state';
import { upsertThreadTier } from '$lib/server/thread_state';
import { touchLastActivity } from '$lib/server/thread_meta';
import { factGate } from '$lib/server/routing/factGate';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import { systemReadTools } from '$lib/server/chat/system_read_tools';
import {
	beginActiveStream,
	finishWithReplyId,
	rollbackOrphanTurn,
	streamResponseFromBuffer,
	type SullyRoutingFrame
} from '$lib/server/chat/sdk_stream_common';
import {
	listOllamaCloudAutoModels,
	normalizeOllamaCloudModelId
} from '$lib/server/chat/ollama_cloud_chain';

const OLLAMA_BASE_URL =
	process.env.OLLAMA_BASE_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:11434';
const OLLAMA_V1 = `${OLLAMA_BASE_URL}/v1`;

// Fallback model chain when Claude is unavailable. These route through Ollama
// Cloud (ollama.com) using the existing local daemon + sign-in, no separate
// API key needed. Tried in order: strongest → fastest.
const FALLBACK_MODELS = listOllamaCloudAutoModels('chat');

// ---------------------------------------------------------------------------
// Typed error frames. Every sdk-stream error path emits a `data-sully-error`
// data part {code, message, recovery} IN ADDITION to the SDK-standard error
// part, so the client can render an actionable recovery hint instead of a raw
// provider string. Shared by sdk_cli_reply / sdk_local_reply / +server.ts
// (this module is the one scope-shared home for the helpers).
// ---------------------------------------------------------------------------

export type SullyErrorCode =
	| 'credential_unavailable'
	| 'rate_limit'
	| 'timeout'
	| 'provider_error'
	| 'context_overflow'
	| 'unknown';

export type SullyErrorFrame = {
	code: SullyErrorCode;
	message: string;
	recovery: string;
};

const SULLY_ERROR_RECOVERY: Record<SullyErrorCode, string> = {
	credential_unavailable: 'Switch model — this one is missing a working credential.',
	rate_limit: 'Retry in ~30s or switch model.',
	timeout: 'Retry — the provider did not answer in time.',
	provider_error: 'Retry, or switch model if it keeps failing.',
	context_overflow: 'Start a new thread — this one exceeds the model context window.',
	unknown: 'Retry, or switch model if it persists.'
};

export function sullyErrorFrame(code: SullyErrorCode, message: string): SullyErrorFrame {
	return { code, message, recovery: SULLY_ERROR_RECOVERY[code] };
}

/** Auto mode may silently try the next provider when these occur before any text. */
export function isAutoFallbackableError(code: SullyErrorCode): boolean {
	return (
		code === 'rate_limit' ||
		code === 'provider_error' ||
		code === 'credential_unavailable' ||
		code === 'timeout' ||
		code === 'unknown'
	);
}

export function classifySullyError(message: string, statusCode?: number): SullyErrorFrame {
	const msg = message || 'unknown_stream_error';
	const m = msg.toLowerCase();
	let code: SullyErrorCode = 'unknown';
	if (statusCode === 404 || /not.?found|model.*not found|does not exist|unknown model/.test(m)) {
		code = 'provider_error';
	} else if (
		statusCode === 401 ||
		statusCode === 403 ||
		/credential unavailable|authentication|permission|api key|unauthorized|token expired|auth failed/.test(
			m
		)
	) {
		code = 'credential_unavailable';
	} else if (statusCode === 429 || /rate.?limit|too many requests|quota exceeded/.test(m)) {
		code = 'rate_limit';
	} else if (/timed? ?out|etimedout|abort|deadline exceeded/.test(m)) {
		code = 'timeout';
	} else if (
		/context.{0,24}(window|length|overflow)|prompt is too long|too many tokens|maximum context|token limit exceeded/.test(
			m
		)
	) {
		code = 'context_overflow';
	} else if (
		(statusCode !== undefined && statusCode >= 500) ||
		/overloaded|internal server|bad gateway|service unavailable|econnrefused|econnreset|fetch failed|socket hang up/.test(
			m
		)
	) {
		code = 'provider_error';
	}
	return sullyErrorFrame(code, msg);
}

// Structural writer type (same pattern as ReplyIdWriter in sdk_stream_common)
// so any UIMessageStream writer satisfies it without dragging generics around.
export type SullyErrorWriter = {
	write: (chunk: { type: 'data-sully-error'; data: SullyErrorFrame }) => void;
};

export function emitSullyError(writer: SullyErrorWriter, frame: SullyErrorFrame): void {
	try {
		writer.write({ type: 'data-sully-error', data: frame });
	} catch {
		/* stream already closed — the SDK-standard error part remains the fallback */
	}
}

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

function describeDirectError(
	error: unknown,
	modelId: string
): { text: string; statusCode?: number } {
	const err = error as RetryError;
	const apiErr: ApiCallError =
		(err.errors && err.errors.length ? err.errors[err.errors.length - 1] : undefined) ??
		err.lastError ??
		err.cause ??
		err;
	const statusCode = apiErr.statusCode ?? (err as { statusCode?: number }).statusCode;

	const body = apiErr.responseBody;
	if (body) {
		try {
			const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } };
			if (parsed.error?.type) {
				const t = parsed.error.type;
				const m = parsed.error.message;
				if (t === 'rate_limit_error') {
					return {
						text: `Rate limited on ${modelId}. Wait ~30s or switch model (Haiku, Gemini, Local).`,
						statusCode
					};
				}
				if (t === 'invalid_request_error') {
					return { text: `Invalid request to ${modelId}: ${m || t}`, statusCode };
				}
				if (t === 'authentication_error' || t === 'permission_error') {
					return {
						text: `Auth failed for ${modelId} (${t}). Token expired or lacks access. ${m || ''}`,
						statusCode
					};
				}
				if (t === 'not_found_error') {
					return { text: `Model not found: ${modelId}. ${m || ''}`, statusCode };
				}
				if (t === 'overloaded_error') {
					return {
						text: `Provider overloaded (${modelId}). Try again in a moment or switch model.`,
						statusCode
					};
				}
				return { text: `${t}${m ? ': ' + m : ''} (${modelId})`, statusCode };
			}
		} catch {
			/* fall through */
		}
	}
	if (statusCode) {
		return {
			text: `HTTP ${statusCode} from ${modelId}: ${apiErr.message || 'no detail'}`,
			statusCode
		};
	}
	return {
		text: apiErr.message || (err as { message?: string }).message || 'unknown_stream_error',
		statusCode
	};
}

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

function getAnthropicAuthForModel(modelId: string): { authToken?: string; apiKey?: string } {
	const isHaiku = /haiku/i.test(modelId);
	const oauth = getAnthropicOAuth();
	const apiKey = getAnthropicApiKey();

	if (isHaiku && oauth) return { authToken: oauth };
	if (apiKey) return { apiKey };
	if (oauth) return { authToken: oauth };
	return {};
}

/** Pre-flight check: true when the anthropic daily token cap is exceeded. */
export function isAnthropicCapExceeded(): boolean {
	const cap = parseInt(process.env.ANTHROPIC_DAILY_TOKEN_CAP || '1000000', 10);
	if (!Number.isFinite(cap) || cap <= 0) return false;
	const used = getTokenUsage('anthropic');
	return used >= cap;
}

export function pickFallbackModel(): ReturnType<typeof pickModel> | null {
	// Route fallback models through the local Ollama daemon, which proxies
	// `*-cloud` tags to ollama.com using the existing sign-in / OLLAMA_API_KEY.
	// No separate API key needed — consolidated billing on the Ollama Cloud
	// subscription. Tried strongest → fastest.
	const localProvider = createOpenAICompatible({
		name: 'ollama-local',
		baseURL: OLLAMA_V1,
		apiKey: 'ollama'
	});
	for (const modelId of FALLBACK_MODELS) {
		try {
			const raw = localProvider(modelId);
			const model = wrapLanguageModel({
				model: raw,
				middleware: extractReasoningMiddleware({ tagName: 'think' })
			});
			return { model, modelId };
		} catch {
			continue;
		}
	}
	return null;
}

function getGoogleKey(): string {
	return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

export function pickModel(provider: Provider, tier: Tier, requestedModel?: string) {
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
		const localProvider = createOpenAICompatible({
			name: 'ollama-local',
			baseURL: OLLAMA_V1,
			apiKey: 'ollama'
		});
		const raw = localProvider(modelId);
		const model = wrapLanguageModel({
			model: raw,
			middleware: extractReasoningMiddleware({ tagName: 'think' })
		});
		return { model, modelId };
	}
	const apiKey = getGoogleKey();
	if (!apiKey) throw new Error('Google credential unavailable');
	return { model: createGoogleGenerativeAI({ apiKey })(modelId), modelId };
}

export function resolveDirectModel(opts: {
	ctx: PreparedStreamContext;
	requestedModel?: string;
}): ReturnType<typeof pickModel> {
	const { ctx, requestedModel } = opts;
	const explicitPick = Boolean(requestedModel?.trim());
	// Honor explicit picker choices — fact-gate override is for Auto/default routing only.
	const factTurn =
		!explicitPick && ctx.allowSensitive && factGate(ctx.userText).category === 'world_fact';
	if (factTurn) {
		const factModel = process.env.COMPANION_FACT_MODEL || 'gpt-oss:120b-cloud';
		const cloud = createOpenAICompatible({
			name: 'ollama-fact',
			baseURL: OLLAMA_V1,
			apiKey: 'ollama'
		});
		const factModelHandle = wrapLanguageModel({
			model: cloud(factModel),
			middleware: extractReasoningMiddleware({ tagName: 'think' })
		});
		return { model: factModelHandle, modelId: factModel };
	}
	return pickModel(ctx.provider, ctx.currentTier, requestedModel);
}

export type DirectStreamAttemptResult = {
	ok: boolean;
	textEmitted: boolean;
	errorFrame?: SullyErrorFrame;
};

/** Run one direct SDK stream attempt; caller owns chunk recording (buffer or staging). */
export async function runDirectStreamAttempt(opts: {
	ctx: PreparedStreamContext;
	modelHandle: ReturnType<typeof pickModel>;
	tools: ToolSet;
	routing?: SullyRoutingFrame;
	record: (chunk: UIMessageChunk) => void;
	turnAbort: AbortSignal;
	suppressErrorFrames?: boolean;
}): Promise<DirectStreamAttemptResult> {
	const { ctx, modelHandle, tools, routing, record, turnAbort, suppressErrorFrames } = opts;
	const turnStartedAt = Date.now();
	const directTools = { ...tools, ...systemReadTools };
	const systemToolsNote =
		'\n\n[System inspection] You have READ-ONLY tools to check the REAL state of the LogueOS services on this machine (ROOM): list_services, service_status, service_logs, system_health. When the operator asks whether a service is up/enabled/healthy, why one failed or restarted, or about disk/memory/reachability, CALL the relevant tool and reason over the actual result — do NOT guess or state service status from memory. Only the nine whitelisted units can be inspected; these tools cannot start, stop, or restart anything.';
	const directSystemPrompt = ctx.systemPrompt + systemToolsNote;

	let textEmitted = false;
	let directErrored = false;
	let errorFrame: SullyErrorFrame | undefined;

	if (routing) {
		record({ type: 'data-sully-routing', data: routing });
	}

	const result = streamText({
		model: modelHandle.model,
		system: directSystemPrompt,
		messages: await convertToModelMessages(ctx.modelMessages),
		tools: directTools,
		stopWhen: stepCountIs(15),
		abortSignal: turnAbort
	});

	const bufferWriter = {
		write: (chunk: UIMessageChunk) => {
			if (chunk.type === 'text-delta') textEmitted = true;
			record(chunk);
		}
	};

	let resolveAttempt!: (value: DirectStreamAttemptResult) => void;
	const attemptDone = new Promise<DirectStreamAttemptResult>((resolve) => {
		resolveAttempt = resolve;
	});

	const uiStream = result.toUIMessageStream({
		sendReasoning: true,
		sendFinish: false,
		originalMessages: ctx.messages,
		generateMessageId: () => generateId(),
		onError: (error: unknown) => {
			directErrored = true;
			const { text, statusCode } = describeDirectError(error, modelHandle.modelId);
			errorFrame = classifySullyError(text, statusCode);
			if (!suppressErrorFrames) {
				emitSullyError(bufferWriter, errorFrame);
			}
			return text;
		},
		onFinish: async ({ responseMessage }) => {
			let finalReason: FinishReason | undefined;
			try {
				finalReason = await result.finishReason;
			} catch {
				finalReason = 'error';
			}

			const parts = responseMessage.parts || [];
			const replyText = parts
				.filter((p) => p.type === 'text')
				.map((p) => (p as { type: 'text'; text: string }).text)
				.join('');
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
					ctx.provider === 'anthropic' ? 'cc' : ctx.provider === 'local' ? 'local' : 'agy';
				let promptTokens: number | null = null;
				let completionTokens: number | null = null;
				try {
					const usage = await result.usage;
					promptTokens = usage?.inputTokens ?? null;
					completionTokens = usage?.outputTokens ?? null;
				} catch {
					/* usage unavailable */
				}
				const replyId = persistAssistantTurn({
					text: finalText,
					sender: senderLabel,
					threadId: ctx.threadId,
					model: modelHandle.modelId,
					tier: ctx.currentTier,
					taskId: ctx.taskId,
					provider: ctx.provider,
					promptTokens,
					completionTokens,
					latencyMs: Date.now() - turnStartedAt,
					error: toolErrors.length > 0 ? toolErrors.join(' | ').slice(0, 500) : null,
					reused: ctx.reused
				});
				try {
					const totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
					if (totalTokens > 0) {
						addTokenUsage(ctx.provider, totalTokens, modelHandle.modelId);
					}
				} catch {
					/* token tracking must never break the reply */
				}
				finishWithReplyId(bufferWriter, replyId, finalReason);
				void applyTurnDecision(ctx.shadowDecision, {
					taskId: ctx.taskId,
					threadId: ctx.threadId,
					targetRepo: ctx.targetRepo,
					userText: ctx.userText,
					reused: ctx.reused
				}).catch((e) => {
					console.error('[sdk-stream] autonomous-dispatch failed', e);
				});
				resolveAttempt({ ok: true, textEmitted: true, errorFrame });
				return;
			}

			if (directErrored || finalReason === 'error') {
				if (!suppressErrorFrames) {
					bufferWriter.write({ type: 'finish', finishReason: finalReason });
				}
				resolveAttempt({ ok: false, textEmitted, errorFrame });
				return;
			}

			errorFrame = classifySullyError('No reply was generated.', undefined);
			if (!suppressErrorFrames) {
				emitSullyError(bufferWriter, errorFrame);
				bufferWriter.write({ type: 'finish', finishReason: finalReason ?? 'error' });
			}
			resolveAttempt({ ok: false, textEmitted, errorFrame });
		}
	});

	try {
		const reader = uiStream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.type === 'text-delta') textEmitted = true;
			record(value);
		}
	} catch (e) {
		console.error('[sdk-stream] direct stream pump failed', e);
		if (!errorFrame) {
			errorFrame = classifySullyError(
				e instanceof Error ? e.message : 'unknown_stream_error',
				undefined
			);
		}
		return { ok: false, textEmitted, errorFrame };
	}

	return attemptDone;
}

export async function handleDirectReply(opts: {
	ctx: PreparedStreamContext;
	request: Request;
	modelHandle: ReturnType<typeof pickModel>;
	tools: ToolSet;
	routing?: SullyRoutingFrame;
}): Promise<Response> {
	const { ctx, modelHandle, tools, routing } = opts;
	const turnAbort = new AbortController();
	const streamHandle = beginActiveStream(ctx.threadId, {
		onSupersede: () => turnAbort.abort('superseded')
	});

	void (async () => {
		try {
			const attempt = await runDirectStreamAttempt({
				ctx,
				modelHandle,
				tools,
				routing,
				record: (chunk) => streamHandle.record(chunk),
				turnAbort: turnAbort.signal
			});
			if (!attempt.ok) {
				rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
			}
		} catch (e) {
			console.error('[sdk-stream] direct reply failed', e);
			rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
		} finally {
			streamHandle.end();
		}
	})();

	return streamResponseFromBuffer(ctx.threadId, 0);
}
