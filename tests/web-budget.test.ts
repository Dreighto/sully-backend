// Lock the Perplexity daily-spend budget math. The actual DB write/read is
// integration-tested live; here we pin the pure cost function and the env-read
// budget so a stray edit can't accidentally break the operator's $0.50/day cap.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
	SONAR_REQUEST_CENTS,
	SONAR_INPUT_PER_TOKEN_CENTS,
	SONAR_OUTPUT_PER_TOKEN_CENTS,
	estimateSonarCostCents,
	dailyBudgetCents
} from '../src/lib/server/web_usage';

describe('estimateSonarCostCents', () => {
	it('zero tokens → just the per-request fee (0.5¢ = $0.005)', () => {
		expect(estimateSonarCostCents(0, 0)).toBeCloseTo(SONAR_REQUEST_CENTS, 6);
	});

	it('adds linear token costs at $1/M each direction', () => {
		const cost = estimateSonarCostCents(10_000, 5_000);
		const expected =
			SONAR_REQUEST_CENTS +
			10_000 * SONAR_INPUT_PER_TOKEN_CENTS +
			5_000 * SONAR_OUTPUT_PER_TOKEN_CENTS;
		expect(cost).toBeCloseTo(expected, 6);
	});

	it('clamps negative token counts to zero (defensive)', () => {
		expect(estimateSonarCostCents(-100, -100)).toBeCloseTo(SONAR_REQUEST_CENTS, 6);
	});

	it('realistic per-query cost: a 500-token sonar call is roughly 0.55¢', () => {
		// 250 in + 250 out tokens is a typical short query. Pins the dollar shape
		// so a unit slip (¢ vs $, microcents, etc.) shows up immediately. At this
		// cost, the default 50¢/day cap hits at ~90 queries — exactly the budget
		// shape the operator agreed to.
		const perCall = estimateSonarCostCents(250, 250);
		expect(perCall).toBeGreaterThan(0.4);
		expect(perCall).toBeLessThan(0.7);
	});
});

describe('dailyBudgetCents', () => {
	const orig = process.env.WEB_SEARCH_DAILY_BUDGET_CENTS;
	beforeEach(() => delete process.env.WEB_SEARCH_DAILY_BUDGET_CENTS);
	afterEach(() => {
		if (orig === undefined) delete process.env.WEB_SEARCH_DAILY_BUDGET_CENTS;
		else process.env.WEB_SEARCH_DAILY_BUDGET_CENTS = orig;
	});

	it('defaults to 50¢ ($0.50/day) when env is unset', () => {
		expect(dailyBudgetCents()).toBe(50);
	});

	it('honors the env override', () => {
		process.env.WEB_SEARCH_DAILY_BUDGET_CENTS = '25';
		expect(dailyBudgetCents()).toBe(25);
	});

	it('treats 0 / negative / non-numeric as "cap disabled" (0)', () => {
		process.env.WEB_SEARCH_DAILY_BUDGET_CENTS = '0';
		expect(dailyBudgetCents()).toBe(0);
		process.env.WEB_SEARCH_DAILY_BUDGET_CENTS = '-5';
		expect(dailyBudgetCents()).toBe(0);
		process.env.WEB_SEARCH_DAILY_BUDGET_CENTS = 'banana';
		expect(dailyBudgetCents()).toBe(0);
	});
});
