// Ollama Cloud model chain for Auto fallforward. Only models registered on the
// local daemon (via `ollama pull …-cloud` / signin) can be used. DeepSeek v4
// uses the `:cloud` tag (not the stale `:671b-cloud` guess). Override with
// SULLY_AUTO_OLLAMA_CHAIN / _FLASH / _PRO.

import type { Tier } from '$lib/server/phase_classifier';

export const OLLAMA_CLOUD_DEEPSEEK_FLASH = 'deepseek-v4-flash:cloud';
export const OLLAMA_CLOUD_DEEPSEEK_PRO = 'deepseek-v4-pro:cloud';

const DEFAULT_BACKUP = ['qwen3-coder:480b-cloud', 'gpt-oss:20b-cloud'] as const;

/** Map legacy picker ids to live Ollama cloud tags. */
export function normalizeOllamaCloudModelId(modelId: string): string {
	if (modelId === 'deepseek-v4-flash:671b-cloud') return OLLAMA_CLOUD_DEEPSEEK_FLASH;
	if (modelId === 'deepseek-v4-pro:671b-cloud') return OLLAMA_CLOUD_DEEPSEEK_PRO;
	return modelId;
}

function parseChain(raw: string | undefined): string[] {
	if (!raw?.trim()) return [...DEFAULT_BACKUP];
	return raw
		.split(',')
		.map((s) => normalizeOllamaCloudModelId(s.trim()))
		.filter(Boolean);
}

/** Ordered cloud model ids to try for Auto mode (first match wins). */
export function listOllamaCloudAutoModels(tier: Tier): string[] {
	const flash = normalizeOllamaCloudModelId(
		process.env.SULLY_AUTO_OLLAMA_FLASH?.trim() || OLLAMA_CLOUD_DEEPSEEK_FLASH
	);
	const pro = normalizeOllamaCloudModelId(
		process.env.SULLY_AUTO_OLLAMA_PRO?.trim() || OLLAMA_CLOUD_DEEPSEEK_PRO
	);
	const backup = parseChain(process.env.SULLY_AUTO_OLLAMA_CHAIN);
	const primary = tier === 'chat' ? [flash, pro] : [pro, flash];
	return [...new Set([...primary, ...backup])];
}

/** Legacy single-id helper — first entry in the Auto chain. */
export function primaryOllamaCloudAutoModel(tier: Tier): string {
	return listOllamaCloudAutoModels(tier)[0] ?? OLLAMA_CLOUD_DEEPSEEK_FLASH;
}

export { DEFAULT_BACKUP as OLLAMA_CLOUD_DEFAULT_CHAIN };
