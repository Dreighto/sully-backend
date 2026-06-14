// LLM Router — OAuth-first auth chain + cross-provider fall-forward.
//
// Routes by tier (chat / planning / deep / local) with provider preference
// order: anthropic → gemini → openai → ollama. Gemini-preference mode
// is used when the operator has selected the 'agy' agent lock.
//
// 402 billing error: rotate credential within same provider, do NOT
// drop to a lower model tier. Surface the error.
//
// 5xx / cap-exhausted: fall forward to next-cheapest provider in the
// SAME tier before returning an error to the operator.
//
// Always returns provider_used + model_used so the UI can display them.

import * as anthropic from './providers/anthropic';
import * as gemini from './providers/gemini';
import * as openai from './providers/openai';
import * as ollama from './providers/ollama';
import { getTokenUsage, addTokenUsage } from './thread_state';
import type { Tier } from './phase_classifier';
import { MODELS as CATALOG_MODELS, type Provider as CatalogProvider } from './model_catalog';
import { executeSullyModelCall } from './sully_model_router';

export type { Tier };

// Local Provider type — historical naming (`gemini`/`ollama`) preserved so the
// router's downstream provider dispatch table (anthropic.run / gemini.run / …)
// stays one type away from the catalog. The model id lookup uses the catalog
// (`google`/`local`) via a tiny adapter.
type Provider = 'anthropic' | 'gemini' | 'openai' | 'ollama';

// NOTE: deliberately NOT `providerPrefToApi` (the client-side ProviderPref
// normalizer). This map is keyed by THIS router's own provider namespace
// (`openai`, `ollama`) which has no ProviderPref equivalent — `ollama`→`local`
// and `openai`→`openai` are mappings the picker normalizer can't express. Only
// the `gemini`→`google` row overlaps; folding it in would require per-key
// branching more complex than the table. Left as a dedicated adapter.
const CATALOG_BY_LOCAL: Record<Provider, CatalogProvider> = {
	anthropic: 'anthropic',
	gemini: 'google',
	openai: 'openai',
	ollama: 'local'
};

/** Look up the model id for a tier × provider, via the shared catalog. */
const tierModelFor = (tier: Tier, provider: Provider): string | undefined =>
	CATALOG_MODELS[tier]?.[CATALOG_BY_LOCAL[provider]];

// Default provider order: Anthropic first (Claude Max sub), Gemini second
// (OAuth), OpenAI third (API key only), Ollama last (local).
const DEFAULT_ORDER: Provider[] = ['anthropic', 'gemini', 'openai', 'ollama'];
// When operator selects the 'agy' agent lock, Gemini goes first.
const GEMINI_FIRST_ORDER: Provider[] = ['gemini', 'anthropic', 'openai', 'ollama'];
// When operator pins Anthropic explicitly via the model picker.
const ANTHROPIC_FIRST_ORDER: Provider[] = ['anthropic', 'gemini', 'openai', 'ollama'];

export type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image'; mimeType: string; base64: string };

export interface RouterMessage {
	role: 'user' | 'assistant';
	content: string | ContentPart[];
}

export interface RouterResult {
	reply: string;
	provider_used: string;
	model_used: string;
	tokens_used: number;
	/** True if router fell forward from the operator's preferred provider. */
	fell_forward: boolean;
	mode_used?: string;
	trace_id?: string;
}

function getDailyTokenCap(provider: Provider): number {
	const caps: Record<Provider, number> = {
		anthropic: parseInt(process.env.ANTHROPIC_DAILY_TOKEN_CAP || '1000000', 10),
		openai: parseInt(process.env.OPENAI_DAILY_TOKEN_CAP || '200000', 10),
		gemini: parseInt(process.env.GEMINI_DAILY_TOKEN_CAP || '2000000', 10),
		ollama: Infinity
	};
	return caps[provider] ?? Infinity;
}

function isCapExceeded(provider: Provider): boolean {
	if (provider === 'ollama') return false;
	const used = getTokenUsage(provider);
	const cap = getDailyTokenCap(provider);
	return used >= cap;
}

function getStatus(err: unknown): number {
	return (err as { status?: number }).status ?? 0;
}

export async function routeChat(
	tier: Tier,
	messages: RouterMessage[],
	/** Force a provider preference. 'gemini' or 'anthropic' pins that provider
	 * to the front of the fall-forward order. undefined = default
	 * (Anthropic-first). */
	preference?: 'gemini' | 'anthropic',
	signal?: AbortSignal,
	/** Optional system prompt — formatted per-provider (system param for
	 * Anthropic, systemInstruction for Gemini, leading system message for
	 * OpenAI/Ollama). Pass undefined for a bare conversation. */
	system?: string
): Promise<RouterResult> {
	const sullyResult = await executeSullyModelCall({
		tier,
		messages,
		preference,
		signal,
		system,
		taskShape: ['sully-chat', `tier:${tier}`]
	});
	return {
		reply: sullyResult.reply,
		provider_used: sullyResult.provider_used,
		model_used: sullyResult.model_used,
		tokens_used: sullyResult.tokens_used,
		fell_forward: sullyResult.fell_forward,
		mode_used: sullyResult.mode_used,
		trace_id: sullyResult.trace_id
	};
}

export type RouterStreamEvent =
	| { type: 'token'; text: string }
	| {
			type: 'done';
			reply: string;
			provider_used: string;
			model_used: string;
			tokens_used: number;
			fell_forward: boolean;
	  };

// Streaming variant of routeChat. Yields token events as they arrive from the
// chosen provider, then a single 'done' event with the assembled reply and
// usage metadata. Falls forward across providers in the same tier on failure
// of the first attempt — but only BEFORE any tokens have been yielded
// (mid-stream failures can't be silently retried, the caller would see a
// truncated reply with no signal). Only Anthropic + Gemini support streaming
// today; OpenAI/Ollama fall back to the non-streaming chat() and emit the
// full reply as a single token event.
export async function* routeChatStream(
	tier: Tier,
	messages: RouterMessage[],
	preference?: 'gemini' | 'anthropic',
	signal?: AbortSignal,
	system?: string
): AsyncGenerator<RouterStreamEvent> {
	const order =
		preference === 'gemini'
			? GEMINI_FIRST_ORDER
			: preference === 'anthropic'
				? ANTHROPIC_FIRST_ORDER
				: DEFAULT_ORDER;
	const filteredOrder: Provider[] = tier === 'local' ? ['ollama'] : order;

	let fell_forward = false;

	for (let i = 0; i < filteredOrder.length; i++) {
		const provider = filteredOrder[i];
		const model = tierModelFor(tier, provider);
		if (!model) continue;
		if (provider !== 'ollama' && isCapExceeded(provider)) {
			fell_forward = true;
			continue;
		}

		try {
			const reply: string[] = [];
			let usageTotal = 0;

			if (provider === 'anthropic') {
				if (!anthropic.isAvailable()) continue;
				for await (const evt of anthropic.streamChat({ messages, model, signal, system })) {
					if (evt.type === 'token') {
						reply.push(evt.text);
						yield { type: 'token', text: evt.text };
					} else {
						usageTotal = evt.usage.total;
					}
				}
			} else if (provider === 'gemini') {
				if (!gemini.isAvailable()) continue;
				for await (const evt of gemini.streamChat({ messages, model, signal, system })) {
					if (evt.type === 'token') {
						reply.push(evt.text);
						yield { type: 'token', text: evt.text };
					} else {
						usageTotal = evt.usage.total;
					}
				}
			} else {
				// OpenAI / Ollama — no streamChat yet. Fall back to non-streaming
				// and emit the full reply as a single token. Caller still gets a
				// 'done' event so the UX path is uniform.
				const fn = provider === 'openai' ? openai.chat : ollama.chat;
				if (provider === 'openai' && !openai.isAvailable()) continue;
				const result = await fn({ messages, model, signal, system });
				reply.push(result.reply);
				usageTotal = result.usage.total;
				yield { type: 'token', text: result.reply };
			}

			addTokenUsage(provider, usageTotal);
			yield {
				type: 'done',
				reply: reply.join(''),
				provider_used: provider,
				model_used: model,
				tokens_used: usageTotal,
				fell_forward
			};
			return;
		} catch (err) {
			const status = getStatus(err);
			if (status === 402) {
				throw new Error(
					`${provider} billing limit (402). Credential rotation required — check account standing.`,
					{ cause: err }
				);
			}
			console.error(`[llm_router stream] ${provider} failed (HTTP ${status || 'unknown'}):`, err);
			fell_forward = true;
		}
	}

	throw new Error(
		`All providers exhausted for tier '${tier}' (streaming). Check provider keys and daily caps.`
	);
}
