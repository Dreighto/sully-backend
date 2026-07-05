// Single source of truth for chat + voice model IDs. Pre-PR D, this was
// duplicated across three files:
//   - src/lib/server/llm_router.ts          (legacy non-streaming chat)
//   - src/routes/api/chat/sdk-stream/+server.ts  (SDK streaming chat)
//   - src/routes/api/chat/voice-reply/+server.ts (voice reply, env-only)
// A "make GPT-OSS the new cloud default" or "bump Haiku version" change had to
// remember three places. The catalog owns the matrix now; the three callers
// resolve through it.

import { normalizeOllamaCloudModelId } from '$lib/server/chat/ollama_cloud_chain';
import { runMode, serverConfig } from './config';
import type { Tier } from './phase_classifier';
import { TIER_PROVIDER_MODELS, type CatalogProvider } from '$lib/chat/model-registry';

export type { Tier };

/**
 * Normalized provider name used across the catalog and the SDK chat path.
 * llm_router internally calls Gemini "gemini" — it maps this catalog's
 * `google` onto its own type. Same model, two callers. Aliased from the
 * client-safe registry's CatalogProvider so both stay in lock-step.
 */
export type Provider = CatalogProvider;

// Tier × provider → model id. Now sourced from the canonical client-safe
// registry (src/lib/chat/model-registry.ts) so a version bump lands in one
// place. Re-exported as MODELS for the existing llm_router import.
export const MODELS: Record<Tier, Partial<Record<Provider, string>>> = TIER_PROVIDER_MODELS;

/** Voice-reply path is intentionally simpler: one env-tunable local id. */
export function resolveVoiceModel(): string {
	return process.env.COMPANION_VOICE_MODEL || 'companion-v1-voice:latest';
}

/**
 * Resolve the actual model id for a chat turn. Precedence:
 *   1. Operator's explicit `requestedModel` (the picker passed `body.model`).
 *   2. Companion mode + local provider with no explicit model → the operator's
 *      tuned local default (serverConfig.companionDefaultModel).
 *   3. The tier × provider matrix.
 */
export function resolveChatModel(args: {
	tier: Tier;
	provider: Provider;
	requestedModel?: string;
}): string {
	if (args.requestedModel) return normalizeOllamaCloudModelId(args.requestedModel);
	if (runMode.companion && args.provider === 'local') {
		return serverConfig.companionDefaultModel;
	}
	const id = MODELS[args.tier]?.[args.provider];
	if (!id) {
		throw new Error(
			`model_catalog: no model registered for tier=${args.tier} provider=${args.provider}`
		);
	}
	return id;
}
