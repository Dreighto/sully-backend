// Wave 4 split (2026-07-06): the typed-error-frame helpers moved to
// ./sully_error.ts (dependency-free, so error-frame unit tests don't need to
// stub the DB/dispatch modules this file drags in), and model resolution
// (pickModel/pickFallbackModel/resolveDirectModel/isAnthropicCapExceeded)
// moved to ./model_picker.ts. Both are re-exported here — every symbol this
// file used to export is still importable from this path, unchanged, for the
// ~10 external call sites (sdk_cli_reply, sdk_local_reply, sdk_auto_reply,
// auto_router, auto_provider_cooldown, the sdk-stream route, and their tests).
import {
	convertToModelMessages,
	generateId,
	stepCountIs,
	streamText,
	type FinishReason,
	type ToolSet,
	type UIMessageChunk
} from 'ai';
import type { PreparedStreamContext } from '$lib/server/chat/stream_prepare';
import { persistAssistantTurn } from '$lib/server/chat_turn';
import { extractForPersist } from '$lib/server/chat/artifact_sentinel';
import { addTokenUsage, upsertThreadTier } from '$lib/server/thread_state';
import { touchLastActivity } from '$lib/server/thread_meta';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import { markDeepseekApiFailure, markDeepseekApiSuccess } from '$lib/server/chat/deepseek_api';
import { systemReadTools } from '$lib/server/chat/system_read_tools';
import {
	beginActiveStream,
	finishWithReplyId,
	rollbackOrphanTurn,
	streamResponseFromBuffer,
	type SullyRoutingFrame
} from '$lib/server/chat/sdk_stream_common';
import { classifySullyError, emitSullyError, type SullyErrorFrame } from './sully_error';
import { pickModel } from './model_picker';

export {
	type SullyErrorCode,
	type SullyErrorFrame,
	type SullyErrorWriter,
	sullyErrorFrame,
	isAutoFallbackableError,
	classifySullyError,
	emitSullyError
} from './sully_error';
export {
	isAnthropicCapExceeded,
	pickFallbackModel,
	pickModel,
	resolveDirectModel
} from './model_picker';

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
			// A failed DeepSeek-API turn opens the fallback latch: the client's
			// same-turn retry (and every ds turn for the cooldown) reroutes to
			// Ollama Cloud instead of hammering a dead/unfunded API.
			if (modelHandle.deepseekApi) {
				markDeepseekApiFailure(`${errorFrame.code}: ${text}`);
			}
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

			// WI-7 (durable reasoning): collect the model's reasoning parts so the
			// "Thought process" disclosure persists with the reply and survives a
			// thread reload. Empty when the model emitted no reasoning.
			const reasoningText = parts
				.filter((p) => p.type === 'reasoning')
				.map((p) => (p as { type: 'reasoning'; text: string }).text)
				.join('');

			if (finalText) {
				// Clean DeepSeek-API turn: clear any fallback latch early.
				if (modelHandle.deepseekApi && !directErrored) {
					markDeepseekApiSuccess();
				}
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
				// Direct-SDK models emit inline SULLY_ARTIFACT blocks too — extract
				// + promote before persisting (parity with the CLI-bridge path).
				const extracted = extractForPersist(finalText, {
					threadId: ctx.threadId,
					taskId: ctx.taskId
				});
				if (extracted.artifactTraceId) {
					record({
						type: 'data-sully-artifact',
						data: { traceId: extracted.artifactTraceId }
					} as never);
				}
				const replyId = persistAssistantTurn({
					text: extracted.text,
					sender: senderLabel,
					threadId: ctx.threadId,
					model: modelHandle.modelId,
					tier: ctx.currentTier,
					taskId: ctx.taskId,
					provider: ctx.provider,
					traceId: extracted.artifactTraceId,
					promptTokens,
					completionTokens,
					latencyMs: Date.now() - turnStartedAt,
					error: toolErrors.length > 0 ? toolErrors.join(' | ').slice(0, 500) : null,
					reused: ctx.reused,
					reasoning: reasoningText
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
