// Resilience layer for the hybrid brain — cooldown breakers, retry budgets,
// and the degradation chain. Parameters are production defaults borrowed from
// LiteLLM/Kong (design doc: 2026-07-04_hybrid-brain-infrastructure-design.md).
//
// Pure + clock-injectable: no imports from server internals, fully unit-tested.
// The kernel precedents: cooldown = worker demotion, chain order = routing
// table, "degrade loudly" = taint. Nothing here is a novel mechanism.

export interface Clock {
	now(): number;
}
const REAL_CLOCK: Clock = { now: () => Date.now() };

// ── Cooldown breaker (LiteLLM defaults) ──────────────────────────────────────
// A failing tier sits out COOLDOWN_MS after a hard failure (timeout/5xx/429),
// or when >50% of its requests fail within the rolling window (min sample
// applies so one early failure can't trip it). Auth failures (401/403) cool
// longer and are config errors, not transients — the caller should alert.
export const COOLDOWN_MS = 5_000;
export const AUTH_COOLDOWN_MS = 60_000;
export const FAIL_WINDOW_MS = 60_000;
export const FAIL_RATE_TRIP = 0.5;
export const FAIL_RATE_MIN_SAMPLES = 4;

export type FailureKind = 'timeout' | 'server' | 'ratelimit' | 'auth' | 'network';

export class CooldownBreaker {
	private coolUntil = 0;
	private events: Array<{ at: number; ok: boolean }> = [];
	constructor(private clock: Clock = REAL_CLOCK) {}

	recordSuccess(): void {
		this.events.push({ at: this.clock.now(), ok: true });
		this.prune();
	}

	recordFailure(kind: FailureKind): void {
		const now = this.clock.now();
		this.events.push({ at: now, ok: false });
		this.prune();
		// Hard failures cool immediately (LiteLLM: 429/timeout/5xx → ~5s out).
		const cool = kind === 'auth' ? AUTH_COOLDOWN_MS : COOLDOWN_MS;
		this.coolUntil = Math.max(this.coolUntil, now + cool);
	}

	/** Rolling-window trip: >50% failures with enough samples → cool down. */
	private prune(): void {
		const cutoff = this.clock.now() - FAIL_WINDOW_MS;
		this.events = this.events.filter((e) => e.at >= cutoff);
		if (this.events.length >= FAIL_RATE_MIN_SAMPLES) {
			const fails = this.events.filter((e) => !e.ok).length;
			if (fails / this.events.length > FAIL_RATE_TRIP) {
				this.coolUntil = Math.max(this.coolUntil, this.clock.now() + COOLDOWN_MS);
			}
		}
	}

	isCooling(): boolean {
		return this.clock.now() < this.coolUntil;
	}

	/** Healthy behavior clears history (LiteLLM: counters reset on recovery). */
	reset(): void {
		this.coolUntil = 0;
		this.events = [];
	}
}

// ── Retry budget (attempts AND deadline, full jitter) ────────────────────────
// Never a bare retry count: a retry is only allowed while attempts remain AND
// the absolute deadline leaves room for a realistic attempt. Full jitter is
// the safest backoff under fan-out.
export interface RetryBudgetOpts {
	maxAttempts: number;
	deadlineMs: number;
	baseBackoffMs?: number;
	/** Minimum time a provider attempt realistically needs. */
	minAttemptMs?: number;
	random?: () => number;
}

export class RetryBudget {
	private attempts = 0;
	private readonly start: number;
	constructor(
		private opts: RetryBudgetOpts,
		private clock: Clock = REAL_CLOCK
	) {
		this.start = clock.now();
	}

	recordAttempt(): void {
		this.attempts += 1;
	}

	get attemptsUsed(): number {
		return this.attempts;
	}

	remainingMs(): number {
		return Math.max(0, this.opts.deadlineMs - (this.clock.now() - this.start));
	}

	shouldRetry(): boolean {
		if (this.attempts >= this.opts.maxAttempts) return false;
		return this.remainingMs() > (this.opts.minAttemptMs ?? 500);
	}

	/** Full-jitter backoff: uniform(0, base * 2^attempt), capped by remaining time. */
	nextBackoffMs(): number {
		const base = this.opts.baseBackoffMs ?? 250;
		const cap = Math.min(base * 2 ** this.attempts, this.remainingMs());
		const rnd = this.opts.random ?? Math.random;
		return Math.floor(rnd() * Math.max(0, cap));
	}
}

// ── Degradation chain ────────────────────────────────────────────────────────
// Walk tiers in order; skip cooling tiers; apply the per-tier latency cap;
// record outcomes on each tier's breaker. First success wins. All-exhausted →
// a typed failure the caller can surface honestly (never a silent hang).
export interface TierAttempt<T> {
	id: string;
	maxLatencyMs: number;
	run: (signal: AbortSignal) => Promise<T>;
}

export interface ChainResult<T> {
	ok: boolean;
	value?: T;
	tierUsed?: string;
	/** Per-tier outcome trail for logging/shadow analysis. */
	trail: Array<{ id: string; outcome: 'success' | FailureKind | 'skipped_cooling' }>;
}

export function classifyError(err: unknown): FailureKind {
	const msg = String((err as Error)?.message ?? err ?? '').toLowerCase();
	const status = Number((err as { status?: number })?.status ?? NaN);
	if (status === 401 || status === 403 || msg.includes('unauthorized') || msg.includes('api key'))
		return 'auth';
	if (status === 429 || msg.includes('rate limit')) return 'ratelimit';
	if ((err as Error)?.name === 'AbortError' || msg.includes('timeout') || msg.includes('aborted'))
		return 'timeout';
	if (Number.isFinite(status) && status >= 500) return 'server';
	return 'network';
}

export async function runDegradationChain<T>(
	tiers: TierAttempt<T>[],
	breakers: Map<string, CooldownBreaker>,
	clock: Clock = REAL_CLOCK
): Promise<ChainResult<T>> {
	void clock;
	const trail: ChainResult<T>['trail'] = [];
	for (const tier of tiers) {
		let breaker = breakers.get(tier.id);
		if (!breaker) {
			breaker = new CooldownBreaker();
			breakers.set(tier.id, breaker);
		}
		if (breaker.isCooling()) {
			trail.push({ id: tier.id, outcome: 'skipped_cooling' });
			continue;
		}
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(new Error('timeout')), tier.maxLatencyMs);
		try {
			const value = await tier.run(ctrl.signal);
			breaker.recordSuccess();
			trail.push({ id: tier.id, outcome: 'success' });
			return { ok: true, value, tierUsed: tier.id, trail };
		} catch (err) {
			const kind = classifyError(err);
			breaker.recordFailure(kind);
			trail.push({ id: tier.id, outcome: kind });
		} finally {
			clearTimeout(timer);
		}
	}
	return { ok: false, trail };
}

// Per-tier latency caps from the design doc (voice SLO: TTFT ≤1.5–2s).
export const TIER_LATENCY_MS: Record<string, number> = {
	local: 15_000, // full-response cap; TTFT is monitored separately
	router: 10_000,
	reasoning: 30_000,
	specialist: 120_000
};
