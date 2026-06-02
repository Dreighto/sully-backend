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
	}
];

// Tier × provider → model id. Any field may be absent (e.g. the SDK path has
// no `openai` lane today; `local` tier targets only `local`). Keyed by the
// SERVER provider names (CatalogProvider).
//
// CANONICAL matrix (moved verbatim from model_catalog.ts's MODELS).
//
// 2026-06-02 — chat tier's `local` slot flipped to companion-v2:latest as the
// soft-rollout step (per CC#2's wire-in handoff). Other `local:` slots stay on
// qwen3:14b until v2 is confirmed in real conversation. NOTE: companion mode
// usually bypasses this matrix entirely — COMPANION_DEFAULT_MODEL in .env is
// the live driver. This change covers the fallback path.
export const TIER_PROVIDER_MODELS: Record<Tier, Partial<Record<CatalogProvider, string>>> = {
	chat: {
		anthropic: 'claude-haiku-4-5-20251001',
		google: 'gemini-2.5-flash-lite',
		openai: 'gpt-4o-mini',
		local: 'companion-v2:latest'
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
