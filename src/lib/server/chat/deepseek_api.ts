// DeepSeek API primary / Ollama Cloud fallback for the deepseek-v4 models.
//
// WHY: the picker's deepseek entries carry `:cloud` tags and historically rode
// the operator's Ollama Cloud subscription — but v4-pro is a level-4 (heaviest)
// GPU-time model there, and heavy driving drained the plan quota into $5
// prepaid top-ups. The operator's funded DeepSeek API key serves the SAME
// models per-token (v4-flash $0.14/$0.28 per 1M — a heavy week ≈ $0.20) with a
// prepaid balance as a hard spend cap. So: DeepSeek API is PRIMARY when the
// key is present; Ollama Cloud stays as the flat-rate FALLBACK.
//
// FALLBACK MECHANISM: when a DeepSeek-API turn fails (no balance / auth / API
// down / timeout), the error path calls markDeepseekApiFailure(), which opens a
// cooldown latch. While latched, pickModel routes ds models to Ollama Cloud as
// before. The latch expires (default 10 min) and the next ds turn probes the
// API again — self-healing, no restart needed. A successful turn clears it.

const DEEPSEEK_BASE_URL =
	process.env.DEEPSEEK_BASE_URL?.replace(/\/+$/, '') || 'https://api.deepseek.com';

const COOLDOWN_MS = (() => {
	const n = Number(process.env.DEEPSEEK_API_COOLDOWN_S || '600');
	return (Number.isFinite(n) && n > 0 ? n : 600) * 1000;
})();

let unhealthyUntil = 0;

export function getDeepseekApiKey(): string {
	return process.env.DEEPSEEK_API_KEY?.trim() || '';
}

/** True for the picker/catalog ids this lane serves (deepseek-v4-*, any :cloud suffix). */
export function isDeepseekApiModel(modelId: string): boolean {
	return /^deepseek-v4-(flash|pro)/i.test(modelId);
}

/** Picker/Ollama id -> DeepSeek API model id (strip the ollama :cloud tag). */
export function toDeepseekApiModelId(modelId: string): string {
	return modelId.replace(/:.*$/, '');
}

export function deepseekApiBaseUrl(): string {
	return DEEPSEEK_BASE_URL;
}

/** Route ds models via the DeepSeek API right now? (key present + not latched) */
export function deepseekApiAvailable(): boolean {
	return !!getDeepseekApiKey() && Date.now() >= unhealthyUntil;
}

/** Called by the stream error path when a DeepSeek-API turn fails. */
export function markDeepseekApiFailure(reason: string): void {
	unhealthyUntil = Date.now() + COOLDOWN_MS;
	console.warn(
		`[deepseek_api] failure (${reason.slice(0, 120)}) — falling back to Ollama Cloud for ${COOLDOWN_MS / 1000}s`
	);
}

/** Called on a successful DeepSeek-API turn — clears any latch early. */
export function markDeepseekApiSuccess(): void {
	unhealthyUntil = 0;
}

/** Test hook. */
export function resetDeepseekApiLatch(): void {
	unhealthyUntil = 0;
}
