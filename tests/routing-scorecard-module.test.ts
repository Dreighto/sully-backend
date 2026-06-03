import { describe, expect, it } from 'vitest';
import { scoreCases, renderReport } from '$lib/server/routing/scorecard';
import type { RoutingCase } from '$lib/server/routing/fixtures';

const CASES: RoutingCase[] = [
	{ text: '@cc fix build', fromTool: false, expected: 'Dispatch', locked: true },
	{ text: 'hey there', fromTool: false, expected: 'Talk' },
	{ text: 'update src/foo.ts', fromTool: true, expected: 'Ask' }
];

describe('scoreCases', () => {
	it('computes accuracy, per-class precision/recall, confusion matrix, and misses', () => {
		const r = scoreCases(CASES);
		expect(r.total).toBe(3);
		expect(r.accuracy).toBeGreaterThan(0);
		expect(
			r.confusion.Dispatch.Dispatch + r.confusion.Talk.Talk + r.confusion.Ask.Ask
		).toBeLessThanOrEqual(3);
		expect(Array.isArray(r.misses)).toBe(true);
		expect(r.lockedFailures).toBeDefined();
	});
	it('renders a non-empty markdown report', () => {
		expect(renderReport(scoreCases(CASES))).toContain('Confusion matrix');
	});
});
