import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

import {
	BRAIN_REGISTRY,
	championsInTierOrder,
	getBrain,
	resolveChampion,
	TIER_ORDER,
	type BrainEntry
} from '../src/lib/server/brains/registry';

const TEST_REGISTRY: BrainEntry[] = [
	{
		logicalId: 'local-brain',
		tier: 'local',
		championVersion: 'v1',
		versions: [
			{
				version: 'v1',
				provider: 'ollama',
				model: 'qwen3:14b',
				endpoint: null,
				capabilities: { thinking: true, jsonTools: true, ctxTokens: 8192 },
				rationale: 'test'
			},
			{
				version: 'v2',
				provider: 'ollama',
				model: 'future-better-model:14b',
				endpoint: null,
				capabilities: { thinking: false, jsonTools: true, ctxTokens: 16384 },
				rationale: 'test challenger'
			}
		]
	}
];

describe('brain registry — the model-swap seam', () => {
	it('resolves the declared champion by default', () => {
		const v = resolveChampion('local-brain', TEST_REGISTRY, {});
		expect(v?.version).toBe('v1');
		expect(v?.model).toBe('qwen3:14b');
	});

	it('env override flips the champion (the 2-line model swap)', () => {
		const v = resolveChampion('local-brain', TEST_REGISTRY, {
			SULLY_BRAIN_CHAMPION_LOCAL_BRAIN: 'v2'
		});
		expect(v?.version).toBe('v2');
		expect(v?.model).toBe('future-better-model:14b');
	});

	it('typo’d override falls back to the declared champion, never nothing (fail-safe)', () => {
		const v = resolveChampion('local-brain', TEST_REGISTRY, {
			SULLY_BRAIN_CHAMPION_LOCAL_BRAIN: 'v99-does-not-exist'
		});
		expect(v?.version).toBe('v1');
	});

	it('unknown logical brain returns null', () => {
		expect(resolveChampion('no-such-brain', TEST_REGISTRY, {})).toBeNull();
		expect(getBrain('no-such-brain', TEST_REGISTRY)).toBeNull();
	});

	it('production registry: every champion resolves and covers all four tiers', () => {
		const champs = championsInTierOrder(BRAIN_REGISTRY);
		const tiers = champs.map((c) => c.tier);
		for (const t of TIER_ORDER) expect(tiers).toContain(t);
		// every championVersion names a real version
		for (const b of BRAIN_REGISTRY) {
			expect(b.versions.some((v) => v.version === b.championVersion)).toBe(true);
		}
	});

	it('tier walk order is local→router→reasoning→specialist (degradation order)', () => {
		const champs = championsInTierOrder(BRAIN_REGISTRY);
		expect(champs[0]?.tier).toBe('local');
		expect(champs[champs.length - 1]?.tier).toBe('specialist');
	});
});
