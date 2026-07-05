// Ollama Cloud model chain for Auto fallforward. Only models registered on the
// local daemon (via `ollama pull …-cloud` / signin) can be used — defaults match
// what ROOM actually has today; override with SULLY_AUTO_OLLAMA_CHAIN.

import type { Tier } from '$lib/server/phase_classifier';

const DEFAULT_CHAIN = ['qwen3-coder:480b-cloud', 'gpt-oss:20b-cloud'] as const;

function parseChain(raw: string | undefined): string[] {
	if (!raw?.trim()) return [...DEFAULT_CHAIN];
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Ordered cloud model ids to try for Auto mode (first match wins). */
export function listOllamaCloudAutoModels(tier: Tier): string[] {
	const chain = parseChain(process.env.SULLY_AUTO_OLLAMA_CHAIN);
	const flash = process.env.SULLY_AUTO_OLLAMA_FLASH?.trim();
	const pro = process.env.SULLY_AUTO_OLLAMA_PRO?.trim();
	const tierPreferred = tier === 'chat' ? flash || pro : pro || flash;
	const ordered = tierPreferred ? [tierPreferred, ...chain] : [...chain];
	return [...new Set(ordered)];
}

/** Legacy single-id helper — first entry in the Auto chain. */
export function primaryOllamaCloudAutoModel(tier: Tier): string {
	return listOllamaCloudAutoModels(tier)[0] ?? DEFAULT_CHAIN[0];
}

export { DEFAULT_CHAIN as OLLAMA_CLOUD_DEFAULT_CHAIN };
