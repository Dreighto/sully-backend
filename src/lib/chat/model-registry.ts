// Canonical model registry — the SINGLE source of truth for both the
// client-side picker catalog AND the server-side tier×provider model matrix.
//
// Before this file, the two diverged across:
//   - src/lib/chat/model-choices.ts          (client picker: MODEL_CHOICES)
//   - src/lib/server/model_catalog.ts         (server matrix: MODELS)
// and the client↔server provider-name mismatch ('gemini' vs 'google') was
// mapped ad-hoc in THREE places (streaming.svelte.ts, sdk-stream/+server.ts,
// llm_router.ts). A version bump (e.g. "bump Haiku") or a provider rename had
// to be remembered in multiple files.
//
// This module is CLIENT-SAFE: it imports ONLY types from $lib/types/chat-ui
// (no $lib/server/* leaks), so the client picker and the server catalog can
// both import it. The server's `resolveChatModel` wraps the matrix below;
// the picker re-exports MODEL_REGISTRY as MODEL_CHOICES.

import type { ModelChoice, ProviderPref, Tier } from '$lib/types/chat-ui';

// ── Server-side provider name space ──────────────────────────────────────
// The matrix below is keyed by the SERVER provider names. The client picker
// uses ProviderPref ('gemini'); the server uses Provider ('google'). The two
// are reconciled by `providerPrefToApi` below — the ONE normalizer.
export type CatalogProvider = 'anthropic' | 'google' | 'local' | 'openai';

// The chat model-picker catalog. Each entry maps a user-facing choice to the
// (tier, provider) pair the server router pins. 'auto' (null tier + provider)
// means smart tier routing. Server-side, Sonnet/Opus route through the Claude
// Code CLI bridge (Max OAuth); Haiku/Gemini/Local go direct.
//
// CANONICAL picker entries (moved verbatim from model-choices.ts).
export const MODEL_REGISTRY: ModelChoice[] = [
	{ id: 'auto', label: 'Auto', sublabel: 'smart tier routing', tier: null, provider: null },
	{
		id: 'claude-haiku',
		label: 'Claude Haiku 4.5',
		sublabel: 'fast · chat tier',
		tier: 'chat',
		provider: 'anthropic'
	},
	{
		id: 'claude-sonnet',
		label: 'Claude Sonnet 4.6',
		sublabel: 'planning',
		tier: 'planning',
		provider: 'anthropic'
	},
	{
		id: 'claude-opus',
		label: 'Claude Opus 4.8',
		sublabel: 'deep',
		tier: 'deep',
		provider: 'anthropic'
	},
	{
		id: 'gemini-flash-lite',
		label: 'Gemini 2.5 Flash-lite',
		sublabel: 'fast · chat tier',
		tier: 'chat',
		provider: 'gemini'
	},
	{
		id: 'gemini-flash',
		label: 'Gemini 2.5 Flash',
		sublabel: 'planning',
		tier: 'planning',
		provider: 'gemini'
	},
	{
		id: 'gemini-pro',
		label: 'Gemini 2.5 Pro',
		sublabel: 'deep',
		tier: 'deep',
		provider: 'gemini'
	},
	{ id: 'local', label: 'Local (Ollama)', sublabel: 'offline', tier: 'local', provider: 'local' },
	// Ollama Cloud — giant models the local GPU can't run. The local daemon
	// proxies any `*-cloud` tag up to ollama.com (after `ollama signin`), so
	// these route through the same local provider path; no API key in the app.
	{
		id: 'cloud-gpt-oss-120b',
		label: 'GPT-OSS 120B',
		sublabel: 'cloud · big reasoning',
		tier: 'local',
		provider: 'local',
		model: 'gpt-oss:120b-cloud'
	},
	{
		id: 'cloud-qwen3-coder-480b',
		label: 'Qwen3-Coder 480B',
		sublabel: 'cloud · coding',
		tier: 'local',
		provider: 'local',
		model: 'qwen3-coder:480b-cloud'
	},
	{
		id: 'cloud-kimi-k2',
		label: 'Kimi K2 1T',
		sublabel: 'cloud · frontier · tools',
		tier: 'local',
		provider: 'local',
		model: 'kimi-k2:1t-cloud'
	}
];

// Tier × provider → model id. Any field may be absent (e.g. the SDK path has
// no `openai` lane today; `local` tier targets only `local`). Keyed by the
// SERVER provider names (CatalogProvider).
//
// CANONICAL matrix (moved verbatim from model_catalog.ts's MODELS).
//
// 2026-06-02 — rolled chat.local back to qwen3:14b after companion-v2
// shipped overfit (regurgitating training conversations verbatim). v2 will
// be revisited per CC#2's blackwell-finetune-research brief — lower LR,
// early stopping, native Qwen3 chat template. Until then base qwen3 + the
// Sully system prompt from chat_prompt.ts gives us a working baseline.
export const TIER_PROVIDER_MODELS: Record<Tier, Partial<Record<CatalogProvider, string>>> = {
	chat: {
		anthropic: 'claude-haiku-4-5-20251001',
		google: 'gemini-2.5-flash-lite',
		openai: 'gpt-4o-mini',
		local: 'qwen3:14b'
	},
	planning: {
		anthropic: 'claude-sonnet-4-6',
		google: 'gemini-2.5-flash',
		openai: 'gpt-4o',
		local: 'qwen3:14b'
	},
	deep: {
		anthropic: 'claude-opus-4-8',
		google: 'gemini-2.5-pro',
		openai: 'gpt-4o',
		local: 'qwen3:14b'
	},
	local: {
		// Local tier hard-pins the local provider. Anthropic/Google are listed so
		// fallback callers (sdk-stream's "Auto" picker on local tier) still have a
		// valid id when the operator routes off-local for one turn.
		anthropic: 'claude-haiku-4-5-20251001',
		google: 'gemini-2.5-flash-lite',
		local: 'qwen3:14b'
	}
};

/**
 * The ONE normalizer mapping the client picker's ProviderPref → the server's
 * provider name space. Replaces the three ad-hoc `=== 'gemini' ? 'google'`
 * maps (streaming.svelte.ts, sdk-stream/+server.ts).
 *
 *   'gemini'        → 'google'
 *   'anthropic'     → 'anthropic'
 *   'local'         → 'local'
 *   null|undefined  → undefined   (caller's `??` default takes over)
 *
 * Return type is the precise subset reachable from ProviderPref — it can never
 * be 'openai' — so it stays assignable to the narrower server-route Provider
 * unions ('anthropic' | 'google' | 'local').
 */
export function providerPrefToApi(
	p: ProviderPref | undefined
): 'anthropic' | 'google' | 'local' | undefined {
	if (p === 'gemini') return 'google';
	return p ?? undefined;
}

/**
 * Humanize a raw model id (as it appears in `lastModelUsed` / tier matrix
 * values) into a compact display name suitable for the picker chip's
 * sublabel. Tries the registry's labels first, then falls back to a tidy
 * format derived from the id. Used by Composer.svelte to show "Auto" on the
 * top line and the actually-resolved model (e.g. "Gemini Flash-lite") below.
 */
export function humanizeModelId(id: string): string {
	if (!id) return '';
	// Match by registry's explicit `model` field first (Ollama Cloud pins).
	const direct = MODEL_REGISTRY.find((c) => c.model === id);
	if (direct) return direct.label;
	// Match against the tier × provider matrix to pick up a registry entry
	// with a matching tier+provider pair (covers Auto-resolved cases like
	// 'gemini-2.5-flash-lite' that don't carry an explicit `model` field).
	for (const tier of Object.keys(TIER_PROVIDER_MODELS) as (keyof typeof TIER_PROVIDER_MODELS)[]) {
		const row = TIER_PROVIDER_MODELS[tier];
		for (const [prov, modelId] of Object.entries(row)) {
			if (modelId === id) {
				const reg = MODEL_REGISTRY.find(
					(c) => c.tier === tier && providerPrefToApi(c.provider) === prov && !c.model
				);
				if (reg) return reg.label;
			}
		}
	}
	// Final fallback: tidy the raw id — strip dated suffixes, prefix the family.
	if (/^claude/i.test(id)) {
		if (/opus/i.test(id)) return 'Claude Opus';
		if (/sonnet/i.test(id)) return 'Claude Sonnet';
		if (/haiku/i.test(id)) return 'Claude Haiku';
		return 'Claude';
	}
	if (/^gemini/i.test(id)) {
		if (/flash-lite/i.test(id)) return 'Gemini Flash-lite';
		if (/flash/i.test(id)) return 'Gemini Flash';
		if (/pro/i.test(id)) return 'Gemini Pro';
		return 'Gemini';
	}
	if (/^companion/i.test(id)) return id.replace(/:latest$/, '');
	if (/^qwen/i.test(id)) return id.replace(/:/g, ' ');
	return id;
}
