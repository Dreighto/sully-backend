import { describe, expect, it } from 'vitest';
import { loadRoutingCases } from '$lib/server/routing/fixtures';

describe('routing fixtures', () => {
	it('loads ≥40 well-formed labeled cases', () => {
		const cases = loadRoutingCases();
		expect(cases.length).toBeGreaterThanOrEqual(40);
		for (const c of cases) {
			expect(typeof c.text).toBe('string');
			expect(['Talk', 'Ask', 'Dispatch']).toContain(c.expected);
			expect(typeof c.fromTool).toBe('boolean');
		}
	});
	it('includes the locked regression cases', () => {
		const locked = loadRoutingCases().filter((c) => c.locked);
		expect(locked.length).toBeGreaterThanOrEqual(4);
	});
});
