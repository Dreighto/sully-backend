// Single source of truth for chat + voice model IDs. Pre-PR D, this was
// duplicated across three files:
//   - src/lib/server/llm_router.ts          (legacy non-streaming chat)
//   - src/routes/api/chat/sdk-stream/+server.ts  (SDK streaming chat)
//   - src/routes/api/chat/voice-reply/+server.ts (voice reply, env-only)
// A "make GPT-OSS the new cloud default" or "bump Haiku version" change had to
// remember three places. The catalog owns the matrix now; the three callers
// resolve through it.

import { runMode, serverConfig } from './config';
import type { Tier } from './phase_classifier';

export type { Tier };

/**
 * Normalized provider name used across the catalog and the SDK chat path.
 * llm_router internally calls Gemini "gemini" — it imports `googleAlias` to
 * map this catalog's `google` onto its own type. Same model, two callers.
 */
export type Provider = 'anthropic' | 'google' | 'local' | 'openai';

// Tier × provider → model id. Any field may be absent (e.g. the SDK path has
// no `openai` lane today; `local` tier targets only `local`).
export const MODELS: Record<Tier, Partial<Record<Provider, string>>> = {
	chat: {
		anthropic: 'claude-haiku-4-5-20251001',
		google: 'gemini-2.5-flash-lite',
		openai: 'gpt-4o-mini',
		local: 'qwen2.5:7b'
	},
	planning: {
		anthropic: 'claude-sonnet-4-6',
		google: 'gemini-2.5-flash',
		openai: 'gpt-4o',
		local: 'qwen2.5:14b'
	},
	deep: {
		anthropic: 'claude-opus-4-8',
		google: 'gemini-2.5-pro',
		openai: 'gpt-4o',
		local: 'qwen2.5:14b'
	},
	local: {
		// Local tier hard-pins the local provider. Anthropic/Google are listed so
		// fallback callers (sdk-stream's "Auto" picker on local tier) still have a
		// valid id when the operator routes off-local for one turn.
		anthropic: 'claude-haiku-4-5-20251001',
		google: 'gemini-2.5-flash-lite',
		local: 'qwen2.5:14b'
	}
};

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
	if (args.requestedModel) return args.requestedModel;
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
