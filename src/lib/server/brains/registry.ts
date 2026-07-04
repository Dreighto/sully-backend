// Brain registry — the hybrid brain's model-swap seam (design doc:
// LogueOS-Orchestrator data/peer_reviews/2026-07-04_hybrid-brain-infrastructure-design.md).
//
// A "brain" is pure DATA behind the OpenAI-compatible chat seam every backend
// we run already speaks (Ollama, DeepSeek API, ollama.com). Each logical brain
// carries VERSIONS and a champion pointer, so when a model outclasses the
// incumbent the swap is: add a version entry → flip the champion → reload.
// Rollback is flipping it back. No code ships either way.
//
// Champion override without a deploy: SULLY_BRAIN_CHAMPION_<LOGICAL_ID>
// (uppercased, hyphens→underscores), e.g. SULLY_BRAIN_CHAMPION_LOCAL_BRAIN=v2.
// An override naming an unknown version is IGNORED with a warn — a typo'd env
// var must never take a brain offline (fail-safe, kernel convention).

import { env } from '$env/dynamic/private';

export type BrainTier = 'local' | 'router' | 'reasoning' | 'specialist';

export interface BrainCapabilities {
	/** Model supports a thinking/reasoning mode that can be toggled per request. */
	thinking: boolean;
	/** Reliable strict-JSON tool calling (bench-verified, not vendor-claimed). */
	jsonTools: boolean;
	/** Context window in tokens (conservative floor). */
	ctxTokens: number;
}

export interface BrainVersion {
	version: string;
	provider: 'ollama' | 'deepseek' | 'anthropic-sdk';
	/** Model id in the provider's own namespace. */
	model: string;
	/** OpenAI-compatible base URL; null = provider adapter's default. */
	endpoint: string | null;
	capabilities: BrainCapabilities;
	/** Default request options the seam should apply (e.g. think:false). */
	defaults?: Record<string, unknown>;
	/** One line: why this version exists / bench evidence. */
	rationale: string;
}

export interface BrainEntry {
	logicalId: string;
	tier: BrainTier;
	championVersion: string;
	versions: BrainVersion[];
}

// ── The registry (data, reviewed like config) ────────────────────────────────
// Bench evidence: 2026-07-04 §8a bench (local) + v4-flash/pro API benches.
export const BRAIN_REGISTRY: BrainEntry[] = [
	{
		logicalId: 'local-brain',
		tier: 'local',
		championVersion: 'v1',
		versions: [
			{
				version: 'v1',
				provider: 'ollama',
				model: 'qwen3:14b',
				endpoint: null, // ollama adapter default (127.0.0.1:11434)
				capabilities: { thinking: true, jsonTools: true, ctxTokens: 8192 },
				defaults: { think: false, num_ctx: 8192, temperature: 0.3 },
				rationale:
					'§8a bench winner: 11/11 tools+router (only perfect safety router), 5.6s median think-off, best persona'
			}
		]
	},
	{
		logicalId: 'router-brain',
		tier: 'router',
		championVersion: 'v1',
		versions: [
			{
				version: 'v1',
				provider: 'deepseek',
				model: 'deepseek-v4-flash',
				endpoint: 'https://api.deepseek.com',
				capabilities: { thinking: true, jsonTools: true, ctxTokens: 128000 },
				rationale: 'API bench 6/6 router @ ~2s, ~$0.0001/decision; lighter thinking than pro'
			}
		]
	},
	{
		logicalId: 'reasoning-brain',
		tier: 'reasoning',
		championVersion: 'v1',
		versions: [
			{
				version: 'v1',
				provider: 'deepseek',
				model: 'deepseek-v4-pro',
				endpoint: 'https://api.deepseek.com',
				capabilities: { thinking: true, jsonTools: true, ctxTokens: 128000 },
				rationale: 'API bench 3/3 tools + 4/4 router; thinking model; $0.435/$0.87 per M'
			}
		]
	},
	{
		logicalId: 'specialist-brain',
		tier: 'specialist',
		championVersion: 'v1',
		versions: [
			{
				version: 'v1',
				provider: 'anthropic-sdk',
				model: 'claude-sdk', // resolved by the existing SDK path, not this seam
				endpoint: null,
				capabilities: { thinking: true, jsonTools: true, ctxTokens: 200000 },
				rationale:
					'Frontier specialist on subscription; long agentic chains stay here (§7 boundary)'
			}
		]
	}
];

// ── Resolution ───────────────────────────────────────────────────────────────
const overrideKey = (logicalId: string) =>
	`SULLY_BRAIN_CHAMPION_${logicalId.toUpperCase().replace(/-/g, '_')}`;

export function getBrain(
	logicalId: string,
	registry: BrainEntry[] = BRAIN_REGISTRY
): BrainEntry | null {
	return registry.find((b) => b.logicalId === logicalId) ?? null;
}

/**
 * Resolve a logical brain to its champion version. Env override wins when it
 * names a REAL version; otherwise the registry champion (fail-safe on typos).
 */
export function resolveChampion(
	logicalId: string,
	registry: BrainEntry[] = BRAIN_REGISTRY,
	environment: Record<string, string | undefined> = env as Record<string, string | undefined>
): BrainVersion | null {
	const brain = getBrain(logicalId, registry);
	if (!brain) return null;
	const wanted = environment[overrideKey(logicalId)] || brain.championVersion;
	const hit = brain.versions.find((v) => v.version === wanted);
	if (hit) return hit;
	// Typo'd override → fall back to the declared champion, never to nothing.
	console.warn(
		`[brains] champion override ${overrideKey(logicalId)}=${wanted} names no version; using ${brain.championVersion}`
	);
	return brain.versions.find((v) => v.version === brain.championVersion) ?? null;
}

/** Tier walk order for degradation: local → router → reasoning → specialist. */
export const TIER_ORDER: BrainTier[] = ['local', 'router', 'reasoning', 'specialist'];

export function championsInTierOrder(registry: BrainEntry[] = BRAIN_REGISTRY): Array<{
	logicalId: string;
	tier: BrainTier;
	version: BrainVersion;
}> {
	const out: Array<{ logicalId: string; tier: BrainTier; version: BrainVersion }> = [];
	for (const tier of TIER_ORDER) {
		for (const b of registry.filter((r) => r.tier === tier)) {
			const v = resolveChampion(b.logicalId, registry);
			if (v) out.push({ logicalId: b.logicalId, tier, version: v });
		}
	}
	return out;
}
