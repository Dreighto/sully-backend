import { describe, expect, it } from 'vitest';

import {
	AUTH_COOLDOWN_MS,
	classifyError,
	CooldownBreaker,
	COOLDOWN_MS,
	RetryBudget,
	runDegradationChain,
	type Clock,
	type TierAttempt
} from '../src/lib/server/brains/resilience';

class FakeClock implements Clock {
	t = 1_000_000;
	now() {
		return this.t;
	}
	tick(ms: number) {
		this.t += ms;
	}
}

describe('CooldownBreaker (LiteLLM-default semantics)', () => {
	it('hard failure cools for 5s, then recovers', () => {
		const clock = new FakeClock();
		const b = new CooldownBreaker(clock);
		expect(b.isCooling()).toBe(false);
		b.recordFailure('timeout');
		expect(b.isCooling()).toBe(true);
		clock.tick(COOLDOWN_MS - 1);
		expect(b.isCooling()).toBe(true);
		clock.tick(2);
		expect(b.isCooling()).toBe(false);
	});

	it('auth failure cools LONGER (config error, not transient)', () => {
		const clock = new FakeClock();
		const b = new CooldownBreaker(clock);
		b.recordFailure('auth');
		clock.tick(COOLDOWN_MS + 1);
		expect(b.isCooling()).toBe(true); // still cooling — auth window is 60s
		clock.tick(AUTH_COOLDOWN_MS);
		expect(b.isCooling()).toBe(false);
	});

	it('>50% failures in the window trips the breaker (with min samples)', () => {
		const clock = new FakeClock();
		const b = new CooldownBreaker(clock);
		// 1 fail / 2 events — below min samples, and cooldown from the hard fail expires
		b.recordFailure('server');
		b.recordSuccess();
		clock.tick(COOLDOWN_MS + 1);
		expect(b.isCooling()).toBe(false);
		// build to 3 fails / 5 events (>50%): rolling-window trip re-cools
		b.recordFailure('server');
		clock.tick(COOLDOWN_MS + 1);
		b.recordFailure('server');
		expect(b.isCooling()).toBe(true);
	});

	it('old events age out of the rolling window', () => {
		const clock = new FakeClock();
		const b = new CooldownBreaker(clock);
		for (let i = 0; i < 4; i++) b.recordFailure('server');
		clock.tick(70_000); // beyond FAIL_WINDOW_MS and all cooldowns
		b.recordSuccess();
		expect(b.isCooling()).toBe(false);
	});
});

describe('RetryBudget (attempts AND deadline, full jitter)', () => {
	it('stops at max attempts even with time remaining', () => {
		const clock = new FakeClock();
		const rb = new RetryBudget({ maxAttempts: 2, deadlineMs: 60_000 }, clock);
		rb.recordAttempt();
		expect(rb.shouldRetry()).toBe(true);
		rb.recordAttempt();
		expect(rb.shouldRetry()).toBe(false);
	});

	it('stops when the deadline leaves no room for a realistic attempt', () => {
		const clock = new FakeClock();
		const rb = new RetryBudget({ maxAttempts: 5, deadlineMs: 1_000, minAttemptMs: 800 }, clock);
		rb.recordAttempt();
		clock.tick(300);
		expect(rb.shouldRetry()).toBe(false); // 700ms left < 800ms min attempt
	});

	it('full-jitter backoff is bounded by base*2^attempts and remaining time', () => {
		const clock = new FakeClock();
		const rb = new RetryBudget(
			{ maxAttempts: 5, deadlineMs: 10_000, baseBackoffMs: 200, random: () => 0.999 },
			clock
		);
		rb.recordAttempt();
		expect(rb.nextBackoffMs()).toBeLessThanOrEqual(400);
		rb.recordAttempt();
		expect(rb.nextBackoffMs()).toBeLessThanOrEqual(800);
	});
});

describe('classifyError', () => {
	it('maps statuses and messages to failure kinds', () => {
		expect(classifyError({ status: 401, message: 'x' })).toBe('auth');
		expect(classifyError({ status: 429, message: 'x' })).toBe('ratelimit');
		expect(classifyError({ status: 503, message: 'x' })).toBe('server');
		expect(
			classifyError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
		).toBe('timeout');
		expect(classifyError(new Error('fetch failed'))).toBe('network');
	});
});

describe('runDegradationChain (local→cloud walk, first success wins)', () => {
	const ok = (id: string, value: string): TierAttempt<string> => ({
		id,
		maxLatencyMs: 1_000,
		run: async () => value
	});
	const fail = (id: string, err: Error): TierAttempt<string> => ({
		id,
		maxLatencyMs: 1_000,
		run: async () => {
			throw err;
		}
	});

	it('first healthy tier answers; later tiers untouched', async () => {
		const breakers = new Map<string, CooldownBreaker>();
		const r = await runDegradationChain([ok('local', 'hi'), ok('router', 'nope')], breakers);
		expect(r.ok).toBe(true);
		expect(r.tierUsed).toBe('local');
		expect(r.trail).toEqual([{ id: 'local', outcome: 'success' }]);
	});

	it('failing tier falls forward and gets a cooldown; next call skips it', async () => {
		const breakers = new Map<string, CooldownBreaker>();
		const boom = Object.assign(new Error('upstream 503'), { status: 503 });
		const r1 = await runDegradationChain([fail('local', boom), ok('router', 'cloud')], breakers);
		expect(r1.ok).toBe(true);
		expect(r1.tierUsed).toBe('router');
		expect(r1.trail[0]).toEqual({ id: 'local', outcome: 'server' });
		// second call: local is cooling → skipped without an attempt
		const r2 = await runDegradationChain([ok('local', 'hi'), ok('router', 'cloud')], breakers);
		expect(r2.tierUsed).toBe('router');
		expect(r2.trail[0]).toEqual({ id: 'local', outcome: 'skipped_cooling' });
	});

	it('all tiers exhausted → honest typed failure with a full trail', async () => {
		const breakers = new Map<string, CooldownBreaker>();
		const boom = Object.assign(new Error('rate limit'), { status: 429 });
		const r = await runDegradationChain([fail('local', boom), fail('router', boom)], breakers);
		expect(r.ok).toBe(false);
		expect(r.trail.map((t) => t.outcome)).toEqual(['ratelimit', 'ratelimit']);
	});

	it('per-tier latency cap aborts a hung tier and falls forward', async () => {
		const breakers = new Map<string, CooldownBreaker>();
		const hung: TierAttempt<string> = {
			id: 'local',
			maxLatencyMs: 50,
			run: (signal) =>
				new Promise((_res, rej) => {
					signal.addEventListener('abort', () =>
						rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))
					);
				})
		};
		const r = await runDegradationChain([hung, ok('router', 'cloud')], breakers);
		expect(r.ok).toBe(true);
		expect(r.tierUsed).toBe('router');
		expect(r.trail[0]).toEqual({ id: 'local', outcome: 'timeout' });
	});
});
