import {
	convertToModelMessages,
	generateId,
	stepCountIs,
	streamText,
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
import { getTokenUsage } from '$lib/server/thread_state';
import { upsertThreadTier } from '$lib/server/thread_state';
import { touchLastActivity } from '$lib/server/thread_meta';
import { factGate } from '$lib/server/routing/factGate';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import { systemReadTools } from '$lib/server/chat/system_read_tools';
import {
	beginActiveStream,
	finishWithReplyId,
	rollbackOrphanTurn,
	streamResponseFromBuffer
} from '$lib/server/chat/sdk_stream_common';

const OLLAMA_BASE_URL =
	process.env.OLLAMA_BASE_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:11434';
const OLLAMA_V1 = `${OLLAMA_BASE_URL}/v1`;

// Fallback model chain when Claude is unavailable. These route through Ollama
// Cloud (ollama.com) using the existing local daemon + sign-in, no separate
// API key needed. Tried in order: strongest → fastest.
const FALLBACK_MODELS = ['deepseek-v4-pro:671b-cloud', 'qwen3-coder:480b-cloud'];

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

export function classifySullyError(message: string, statusCode?: number): SullyErrorFrame {
	const msg = message || 'unknown_stream_error';
	const m = msg.toLowerCase();
	let code: SullyErrorCode = 'unknown';
	if (
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
	const statusCode = apiErr.statusCode;

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
			return { model: localProvider(modelId), modelId };
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
		return { model: localProvider(modelId), modelId };
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
	const factTurn = ctx.allowSensitive && factGate(ctx.userText).category === 'world_fact';
	if (factTurn) {
		const factModel = process.env.COMPANION_FACT_MODEL || 'gpt-oss:120b-cloud';
		const cloud = createOpenAICompatible({
			name: 'ollama-fact',
			baseURL: OLLAMA_V1,
			apiKey: 'ollama'
		});
		return { model: cloud(factModel), modelId: factModel };
	}
	return pickModel(ctx.provider, ctx.currentTier, requestedModel);
}

export async function handleDirectReply(opts: {
	ctx: PreparedStreamContext;
	request: Request;
	modelHandle: ReturnType<typeof pickModel>;
	tools: ToolSet;
}): Promise<Response> {
	const { ctx, modelHandle, tools } = opts;
	const turnStartedAt = Date.now();
	const directTools = { ...tools, ...systemReadTools };
	const systemToolsNote =
		'\n\n[System inspection] You have READ-ONLY tools to check the REAL state of the LogueOS services on this machine (ROOM): list_services, service_status, service_logs, system_health. When the operator asks whether a service is up/enabled/healthy, why one failed or restarted, or about disk/memory/reachability, CALL the relevant tool and reason over the actual result — do NOT guess or state service status from memory. Only the nine whitelisted units can be inspected; these tools cannot start, stop, or restart anything.';
	const directSystemPrompt = ctx.systemPrompt + systemToolsNote;
	let directErrored = false;
	const turnAbort = new AbortController();
	const streamHandle = beginActiveStream(ctx.threadId, {
		onSupersede: () => turnAbort.abort('superseded')
	});
	const result = streamText({
		model: modelHandle.model,
		system: directSystemPrompt,
		messages: await convertToModelMessages(ctx.modelMessages),
		tools: directTools,
		stopWhen: stepCountIs(8),
		abortSignal: turnAbort.signal
	});

	// Resumable-stream plumbing: every UIMessage chunk of this turn is recorded
	// into the per-thread ring buffer (sdk_stream_common), and the model stream
	// is pumped independently of the HTTP response. The POST response below —
	// and any later GET /api/chat/sdk-stream/resume — are just subscribers of
	// that buffer, so a dropped client connection neither stalls generation nor
	// loses the turn.
	const bufferWriter = {
		write: (chunk: UIMessageChunk) => streamHandle.record(chunk)
	};

	const uiStream = result.toUIMessageStream({
		sendFinish: false,
		originalMessages: ctx.messages,
		generateMessageId: () => generateId(),
		onError: (error: unknown) => {
			directErrored = true;
			const { text, statusCode } = describeDirectError(error, modelHandle.modelId);
			emitSullyError(bufferWriter, classifySullyError(text, statusCode));
			return text;
		},
		onFinish: async ({ responseMessage }) => {
			if (!streamHandle.isCurrent()) return;
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

			let replyId: number | undefined;
			if (finalText) {
				const senderLabel: 'cc' | 'agy' | 'local' = ctx.provider === 'anthropic' ? 'cc' : 'agy';
				let promptTokens: number | null = null;
				let completionTokens: number | null = null;
				try {
					const usage = await result.usage;
					promptTokens = usage?.inputTokens ?? null;
					completionTokens = usage?.outputTokens ?? null;
				} catch {
					/* usage unavailable */
				}
				replyId = persistAssistantTurn({
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
			} else if (directErrored || finalReason === 'error') {
				rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
				bufferWriter.write({ type: 'finish', finishReason: finalReason });
				return;
			} else {
				// Model finished without emitting reply text (tool-only abort, empty
				// synthesis, etc.). Roll back the orphan operator row + task so the
				// thread does not show a question with no answer forever.
				rollbackOrphanTurn(ctx.operatorRowId, ctx.taskId, ctx.reused);
				emitSullyError(bufferWriter, classifySullyError('No reply was generated.', undefined));
				bufferWriter.write({ type: 'finish', finishReason: finalReason ?? 'error' });
				return;
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
		}
	});

	// Pump the model stream into the buffer detached from the response. The
	// finally-clause covers finish, error, AND rollback: the active stream is
	// always cleared when the turn terminates, so resume returns 204 after.
	void (async () => {
		try {
			const reader = uiStream.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				streamHandle.record(value);
			}
		} catch (e) {
			console.error('[sdk-stream] direct stream pump failed', e);
		} finally {
			streamHandle.end();
		}
	})();

	// The POST response itself is a resume-from-0 subscription over the buffer.
	return streamResponseFromBuffer(ctx.threadId, 0);
}
