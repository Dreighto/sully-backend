// Cost/quota brakes (spec §4.11). All countable signals; no billed API-key path.
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

// Default bounded-retry count for TRANSIENT errors only (never 429). Pinned = 2.
export const DEFAULT_RETRIES = 2;
// Max re-uses of one content fingerprint per conversation before refusal.
const FINGERPRINT_CAP = 1;

export function fingerprintFor(brief: string, category: string, targetRepo: string): string {
	return crypto
		.createHash('sha256')
		.update(`${brief}|${category}|${targetRepo}`)
		.digest('hex')
		.slice(0, 16);
}

// ── Daily dispatch-count budget (rolling window) ────────────────────────────
export function checkDailyCap(): { allowed: boolean; used: number; cap: number } {
	const cap = serverConfig.companionDispatchCap;
	if (!fs.existsSync(serverConfig.memoryDbPath)) return { allowed: true, used: 0, cap };
	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		const cutoff = new Date(
			Date.now() - serverConfig.companionDispatchWindowMin * 60 * 1000
		).toISOString();
		// Count only REAL worker dispatches. Under the task-first / ask-before-
		// dispatch architecture EVERY turn mints a Task, and self-handled turns now
		// reach 'synthesized' (and expired proposals reach 'aborted') — so a
		// status-only filter over-counted pure chat/voice turns and tripped the cap
		// far too early. A real dispatch is the only kind with worker != 'sully'
		// (proposeTask sets 'sully'; createJob sets the actual worker). Also drop
		// 'aborted' so an expired/declined proposal (worker set on the gated row,
		// never sent) doesn't count.
		const row = db
			.prepare(
				`SELECT COUNT(*) AS n FROM pending_jobs
				 WHERE started_at >= ?
				   AND worker != 'sully'
				   AND status NOT IN ('proposed','classified','gated','held','aborted')`
			)
			.get(cutoff) as { n: number };
		return { allowed: row.n < cap, used: row.n, cap };
	} catch {
		return { allowed: true, used: 0, cap }; // table not created yet
	} finally {
		db.close();
	}
}

// ── 429 circuit breaker (module-level state; resets after cooldown) ─────────
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;
let _breakerTrippedAt = 0;
export function trip429(): void {
	_breakerTrippedAt = Date.now();
}
export function breakerOpen(): boolean {
	if (_breakerTrippedAt === 0) return false;
	if (Date.now() - _breakerTrippedAt > BREAKER_COOLDOWN_MS) {
		_breakerTrippedAt = 0;
		return false;
	}
	return true;
}
/** Never retry a 429; bounded retry is for transient (non-429) failures only. */
export function canRetryAfter(statusCode: number): boolean {
	return statusCode !== 429;
}

// ── Token-bucket rate limiter (before the handoff POST) ─────────────────────
export class TokenBucket {
	private tokens: number;
	private last = Date.now();
	constructor(
		private capacity: number,
		private refillPerSec: number
	) {
		this.tokens = capacity;
	}
	take(): boolean {
		const now = Date.now();
		this.tokens = Math.min(
			this.capacity,
			this.tokens + ((now - this.last) / 1000) * this.refillPerSec
		);
		this.last = now;
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}
		return false;
	}
}
// One shared bucket: 5 dispatches burst, refill 1 / 30s.
export const dispatchBucket = new TokenBucket(5, 1 / 30);

// ── Content-fingerprint no-re-escalation ────────────────────────────────────
export function checkFingerprint(fp: string): { allowed: boolean } {
	if (!fs.existsSync(serverConfig.memoryDbPath)) return { allowed: true };
	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		// Proposed/self-handled rows carry fingerprint='' so a real (non-empty)
		// fingerprint never matches them; the status filter is belt-and-braces
		// in case a future caller sets a fingerprint pre-dispatch.
		const row = db
			.prepare(
				`SELECT COUNT(*) AS n FROM pending_jobs
				 WHERE fingerprint = ?
				   AND status NOT IN ('proposed','classified','gated','held')`
			)
			.get(fp) as { n: number };
		return { allowed: row.n <= FINGERPRINT_CAP - 1 };
	} catch {
		return { allowed: true };
	} finally {
		db.close();
	}
}

// ── Two-level kill switch (companion-LOCAL) ─────────────────────────────────
// Level 1: gate new dispatches. Level 2: abort in-flight (wired in
// companionDispatch.killAll). Module-level toggle; reset on restart.
let _killed = false;
export function engageKill(): void {
	_killed = true;
}
export function clearKill(): void {
	_killed = false;
}
export function isKilled(): boolean {
	return _killed;
}
