// Pricing table for the Ops spend dashboard. These convert raw usage
// (tokens / TTS chars / STT minutes) into a rough USD figure.
//
// IMPORTANT: the token rates below are BLENDED ESTIMATES, not billing-accurate
// numbers. The usage tables store a single total token count per provider/day
// with NO prompt/completion split, so we can only apply one blended $/1M rate
// per provider. Treat the resulting chatLlm dollar figure as a ballpark.
//
// Every value is override-able via env so the operator can pin real negotiated
// rates without a code change:
//   LOGUEOS_PRICE_ANTHROPIC_PER_M   (default 6)
//   LOGUEOS_PRICE_OPENAI_PER_M      (default 5)
//   LOGUEOS_PRICE_GEMINI_PER_M      (default 1)
//   LOGUEOS_PRICE_LOCAL_PER_M       (default 0)
//   LOGUEOS_PRICE_TTS_PER_1K        (default 0.30)
//   LOGUEOS_PRICE_STT_PER_MIN       (default 0)

export type SpendProvider = 'anthropic' | 'openai' | 'gemini' | 'local';

// Read a non-negative number from env, falling back on unset/empty/invalid.
function envNum(key: string, fallback: number): number {
	const raw = typeof process !== 'undefined' ? process.env[key] : undefined;
	if (raw === undefined || raw === '') return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Blended $/1M-token ESTIMATES (2026). Deliberately rough midpoints of each
// provider's current chat-tier input+output pricing:
//   anthropic ~6  (Claude Sonnet-class blended)
//   openai    ~5  (GPT-class blended)
//   gemini    ~1  (Gemini Flash/Pro blended)
//   local      0  (Ollama on our own GPU — no marginal $ per token)
export const TOKEN_PRICE_PER_M: Record<SpendProvider, number> = {
	anthropic: envNum('LOGUEOS_PRICE_ANTHROPIC_PER_M', 6),
	openai: envNum('LOGUEOS_PRICE_OPENAI_PER_M', 5),
	gemini: envNum('LOGUEOS_PRICE_GEMINI_PER_M', 1),
	local: envNum('LOGUEOS_PRICE_LOCAL_PER_M', 0)
};

// TTS: USD per 1,000 characters (~$0.30 is a typical cloud-TTS blended rate).
export const TTS_USD_PER_1K_CHARS = envNum('LOGUEOS_PRICE_TTS_PER_1K', 0.3);

// STT: USD per minute. Default 0 — STT runs Jetson-local (free). Override only
// if a paid STT provider is ever wired in.
export const STT_USD_PER_MIN = envNum('LOGUEOS_PRICE_STT_PER_MIN', 0);

// The usage writers label some providers differently from the pricing keys.
// Notably, real Claude spend is logged as `agentSdk` (Claude via the Agent SDK),
// not `anthropic` — without this map those tokens would silently count as $0.
const PROVIDER_ALIASES: Record<string, SpendProvider> = {
	anthropic: 'anthropic',
	agentsdk: 'anthropic',
	claude: 'anthropic',
	openai: 'openai',
	gpt: 'openai',
	gemini: 'gemini',
	google: 'gemini',
	deepseek: 'local',
	local: 'local',
	ollama: 'local'
};

/** Normalize a raw usage `provider` label to a pricing key. Unknown -> undefined. */
export function normalizeProvider(provider: string): SpendProvider | undefined {
	return PROVIDER_ALIASES[provider.trim().toLowerCase()];
}

/** Estimated USD cost of `tokens` for `provider` (alias-normalized). Unknown -> 0. */
export function tokenCostUsd(provider: string, tokens: number): number {
	const key = normalizeProvider(provider);
	const rate = key ? TOKEN_PRICE_PER_M[key] : undefined;
	if (rate === undefined || !Number.isFinite(tokens) || tokens <= 0) return 0;
	return (tokens / 1_000_000) * rate;
}

/** USD cost of `chars` of TTS. */
export function ttsCostUsd(chars: number): number {
	if (!Number.isFinite(chars) || chars <= 0) return 0;
	return (chars / 1000) * TTS_USD_PER_1K_CHARS;
}

/** USD cost of `minutes` of STT (0 by default — Jetson-local). */
export function sttCostUsd(minutes: number): number {
	if (!Number.isFinite(minutes) || minutes <= 0) return 0;
	return minutes * STT_USD_PER_MIN;
}
