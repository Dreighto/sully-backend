import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	generateId,
	stepCountIs,
	streamText,
	type FinishReason,
	type ToolSet
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Tier } from '$lib/server/phase_classifier';
import type { PreparedStreamContext, Provider } from '$lib/server/chat/stream_prepare';
import { resolveChatModel } from '$lib/server/model_catalog';
import { persistAssistantTurn } from '$lib/server/chat_turn';
import { upsertThreadTier } from '$lib/server/thread_state';
import { touchLastActivity } from '$lib/server/thread_meta';
import { factGate } from '$lib/server/routing/factGate';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import { systemReadTools } from '$lib/server/chat/system_read_tools';
import { finishWithReplyId, rollbackOrphanTurn } from '$lib/server/chat/sdk_stream_common';

const OLLAMA_BASE_URL =
	process.env.OLLAMA_BASE_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:11434';
const OLLAMA_V1 = `${OLLAMA_BASE_URL}/v1`;

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
	const result = streamText({
		model: modelHandle.model,
		system: directSystemPrompt,
		messages: await convertToModelMessages(ctx.modelMessages),
		tools: directTools,
		stopWhen: stepCountIs(8)
	});

	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			writer.merge(
				result.toUIMessageStream({
					sendFinish: false,
					originalMessages: ctx.messages,
					generateMessageId: () => generateId(),
					onError: (error: unknown) => {
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
							toolErrors.length > 0
								? [replyText, ...toolErrors].filter(Boolean).join('\n\n')
								: replyText;

						let replyId: number | undefined;
						if (finalText) {
							const senderLabel: 'cc' | 'agy' | 'local' =
								ctx.provider === 'anthropic' ? 'cc' : 'agy';
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
							writer.write({ type: 'finish', finishReason: finalReason });
							return;
						} else {
							upsertThreadTier(ctx.threadId, ctx.currentTier, modelHandle.modelId);
							touchLastActivity(ctx.threadId);
						}

						finishWithReplyId(writer, replyId, finalReason);

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
				})
			);
		}
	});
	return createUIMessageStreamResponse({ stream });
}
