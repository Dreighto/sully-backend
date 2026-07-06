import { extractReasoningMiddleware, wrapLanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Tier } from '$lib/server/phase_classifier';
import type { PreparedStreamContext, Provider } from '$lib/server/chat/stream_prepare';
import { resolveChatModel } from '$lib/server/model_catalog';
import { getTokenUsage } from '$lib/server/thread_state';
import { factGate } from '$lib/server/routing/factGate';
import {
	isDeepseekApiModel,
	deepseekApiAvailable,
	deepseekApiBaseUrl,
	getDeepseekApiKey,
	toDeepseekApiModelId
} from '$lib/server/chat/deepseek_api';
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
		// DeepSeek-v4 models: PRIMARY = the operator's per-token DeepSeek API key
		// (prepaid hard cap, pennies); FALLBACK = Ollama Cloud (flat-rate quota)
		// when the key is absent or the failure latch is open. See deepseek_api.ts.
		if (isDeepseekApiModel(modelId) && deepseekApiAvailable()) {
			const dsProvider = createOpenAICompatible({
				name: 'deepseek-api',
				baseURL: `${deepseekApiBaseUrl()}/v1`,
				apiKey: getDeepseekApiKey()
			});
			const raw = dsProvider(toDeepseekApiModelId(modelId));
			const model = wrapLanguageModel({
				model: raw,
				middleware: extractReasoningMiddleware({ tagName: 'redacted_thinking' })
			});
			return { model, modelId, deepseekApi: true };
		}
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
