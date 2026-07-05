// Read-only spend aggregation for the Ops dashboard. Reads the four existing
// usage tables in the companion DB and rolls them up into a USD report.
//
// This module is strictly ADDITIVE and READ-ONLY: it never writes, never
// alters a schema, and opens the DB `readonly`. It does not touch the usage
// writers (thread_state.ts / web_usage.ts / voice_usage.ts).
//
// Tables (all keyed by `date TEXT` = YYYY-MM-DD):
//   chat_token_usage(date, provider, tokens_used) — LLM tokens/day/provider
//   chat_web_usage(date, cents_spent, requests)   — research/Perplexity spend
//   chat_tts_usage(date, chars_used)              — TTS characters/day
//   chat_stt_usage(date, minutes_used)            — STT minutes/day
//
// Cost model: research is EXACT (cents_spent / 100, real dollars billed);
// chatLlm is an ESTIMATE (blended per-provider token rates); voice uses the
// configured TTS/STT rates (STT default $0, Jetson-local). See pricing.ts.

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';
import { tokenCostUsd, ttsCostUsd, sttCostUsd } from './pricing';

export interface SpendProviderRow {
	provider: string;
	tokens: number;
	costUsd: number;
}

export interface SpendCap {
	provider: string;
	/** Daily token limit. 0 = unlimited. */
	dailyTokenCap: number;
	/** Tokens used today. */
	todayTokens: number;
	/** Monthly spend limit in USD. 0 = unlimited. */
	monthlySpendCap: number;
	/** Spend month-to-date. */
	monthToDate: number;
}

export interface SpendReport {
	today: number;
	monthToDate: number;
	total: number;
	categories: { chatLlm: number; research: number; voice: number };
	providers: SpendProviderRow[];
	dailyTrend: Array<{ date: string; cost: number }>;
	caps: SpendCap[];
	note: string;
}

const NOTE =
	'chatLlm is an ESTIMATE (blended per-provider token rates; override via ' +
	'LOGUEOS_PRICE_<PROVIDER>_PER_M). research is EXACT (real cents billed by ' +
	'Perplexity). voice uses configured TTS/STT rates (STT default $0, Jetson-local).';

// Mirror the usage writers' key convention: they store `date` as
// `new Date().toISOString().slice(0,10)` (UTC-derived). We use the SAME
// convention here so our aggregation keys line up exactly with stored rows and
// never drift by a day at a timezone boundary.
function todayDate(): string {
	return new Date().toISOString().slice(0, 10);
}

// Add `deltaDays` (may be negative) to a YYYY-MM-DD string, staying in UTC.
function shiftDate(iso: string, deltaDays: number): string {
	const d = new Date(iso + 'T00:00:00Z');
	d.setUTCDate(d.getUTCDate() + deltaDays);
	return d.toISOString().slice(0, 10);
}

function round2(x: number): number {
	return Math.round((x + Number.EPSILON) * 100) / 100;
}

// Query helper that tolerates a not-yet-created table (usage tables self-create
// on first write, so a fresh install may not have them yet).
function safeAll<T>(db: Database.Database, sql: string, param: string): T[] {
	try {
		return db.prepare(sql).all(param) as T[];
	} catch {
		return [];
	}
}

function readCaps(providers: SpendProviderRow[]): SpendCap[] {
	const envNum = (key: string, fallback: number): number => {
		const raw = typeof process !== 'undefined' ? process.env[key] : undefined;
		if (raw === undefined || raw === '') return fallback;
		const n = Number(raw);
		return Number.isFinite(n) && n >= 0 ? n : fallback;
	};
	// Per-provider daily token caps (from llm_router.ts env vars).
	const dailyCaps: Record<string, { tokenCap: number; monthlyCap: number }> = {
		anthropic: { tokenCap: envNum('ANTHROPIC_DAILY_TOKEN_CAP', 1_000_000), monthlyCap: envNum('ANTHROPIC_MONTHLY_SPEND_CAP', 0) },
		google: { tokenCap: envNum('GEMINI_DAILY_TOKEN_CAP', 2_000_000), monthlyCap: 0 },
		openai: { tokenCap: envNum('OPENAI_DAILY_TOKEN_CAP', 200_000), monthlyCap: 0 },
		local: { tokenCap: 0, monthlyCap: 0 }
	};
	// Today's tokens per provider from the provider rows (scoped to trend window).
	const todayTokens: Record<string, number> = {};
	const todayProviderCost: Record<string, number> = {};
	const todayStr = todayDate();
	for (const p of providers) {
		// providers is scoped to the trend window. If today is in the window,
		// p.tokens is today's tokens. Approximate: if today is not in the window,
		// the cap check is still meaningful from DB (readCaps can also read from
		// thread_state directly).
		todayTokens[p.provider] = p.tokens;
		todayProviderCost[p.provider] = p.costUsd;
	}
	return Object.entries(dailyCaps)
		.filter(([provider]) => dailyCaps[provider].tokenCap > 0 || dailyCaps[provider].monthlyCap > 0)
		.map(([provider, caps]) => ({
			provider,
			dailyTokenCap: caps.tokenCap,
			todayTokens: todayTokens[provider] ?? getTokensForProvider(provider),
			monthlySpendCap: caps.monthlyCap,
			monthToDate: todayProviderCost[provider] ?? 0
		}));
}

function getTokensForProvider(provider: string): number {
	// Try to read today's token usage directly from the DB.
	try {
		const db = new Database(serverConfig.memoryDbPath, { readonly: true });
		try {
			const row = db
				.prepare('SELECT tokens_used FROM chat_token_usage WHERE date = ? AND provider = ?')
				.get(todayDate(), provider) as { tokens_used: number } | undefined;
			return row?.tokens_used ?? 0;
		} finally {
			db.close();
		}
	} catch {
		return 0;
	}
}

function emptyReport(days: number): SpendReport {
	const n = normalizeDays(days);
	const today = todayDate();
	const start = shiftDate(today, -(n - 1));
	const dailyTrend: Array<{ date: string; cost: number }> = [];
	for (let i = 0; i < n; i++) dailyTrend.push({ date: shiftDate(start, i), cost: 0 });
	return {
		today: 0,
		monthToDate: 0,
		total: 0,
		categories: { chatLlm: 0, research: 0, voice: 0 },
		providers: [],
		dailyTrend,
		caps: [],
		note: NOTE
	};
}

function normalizeDays(days: number): number {
	return Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
}

/**
 * Aggregate spend across the last `days` (default 30). Robust to empty or
 * missing tables — returns zeros, never throws.
 */
export function getSpend(days = 30): SpendReport {
	const n = normalizeDays(days);
	if (!fs.existsSync(serverConfig.memoryDbPath)) return emptyReport(n);

	const today = todayDate();
	const windowStart = shiftDate(today, -(n - 1));
	const monthStart = today.slice(0, 8) + '01';
	// Pull enough history to cover BOTH the trend window and the current
	// calendar month (monthToDate must be a true calendar month, not clipped to
	// the window).
	const queryStart = windowStart < monthStart ? windowStart : monthStart;

	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		const tokenRows = safeAll<{ date: string; provider: string; tokens_used: number }>(
			db,
			'SELECT date, provider, tokens_used FROM chat_token_usage WHERE date >= ?',
			queryStart
		);
		const webRows = safeAll<{ date: string; cents_spent: number }>(
			db,
			'SELECT date, cents_spent FROM chat_web_usage WHERE date >= ?',
			queryStart
		);
		const ttsRows = safeAll<{ date: string; chars_used: number }>(
			db,
			'SELECT date, chars_used FROM chat_tts_usage WHERE date >= ?',
			queryStart
		);
		const sttRows = safeAll<{ date: string; minutes_used: number }>(
			db,
			'SELECT date, minutes_used FROM chat_stt_usage WHERE date >= ?',
			queryStart
		);

		// Per-date category cost maps.
		const llmByDate = new Map<string, number>();
		const researchByDate = new Map<string, number>();
		const voiceByDate = new Map<string, number>();

		// Provider rollup is scoped to the trend window (last `days`).
		const providerTotals = new Map<string, { tokens: number; costUsd: number }>();

		for (const r of tokenRows) {
			const cost = tokenCostUsd(r.provider, r.tokens_used);
			llmByDate.set(r.date, (llmByDate.get(r.date) ?? 0) + cost);
			if (r.date >= windowStart) {
				const cur = providerTotals.get(r.provider) ?? { tokens: 0, costUsd: 0 };
				cur.tokens += Number.isFinite(r.tokens_used) ? r.tokens_used : 0;
				cur.costUsd += cost;
				providerTotals.set(r.provider, cur);
			}
		}
		for (const r of webRows) {
			researchByDate.set(r.date, (researchByDate.get(r.date) ?? 0) + (r.cents_spent ?? 0) / 100);
		}
		for (const r of ttsRows) {
			voiceByDate.set(r.date, (voiceByDate.get(r.date) ?? 0) + ttsCostUsd(r.chars_used));
		}
		for (const r of sttRows) {
			voiceByDate.set(r.date, (voiceByDate.get(r.date) ?? 0) + sttCostUsd(r.minutes_used));
		}

		const dateCost = (d: string): number =>
			(llmByDate.get(d) ?? 0) + (researchByDate.get(d) ?? 0) + (voiceByDate.get(d) ?? 0);

		// Trend + window totals (raw, then rounded on output).
		const dailyTrend: Array<{ date: string; cost: number }> = [];
		let windowLlm = 0;
		let windowResearch = 0;
		let windowVoice = 0;
		for (let i = 0; i < n; i++) {
			const d = shiftDate(windowStart, i);
			dailyTrend.push({ date: d, cost: round2(dateCost(d)) });
			windowLlm += llmByDate.get(d) ?? 0;
			windowResearch += researchByDate.get(d) ?? 0;
			windowVoice += voiceByDate.get(d) ?? 0;
		}

		// Month-to-date over the true calendar month.
		const monthKeys = new Set<string>();
		for (const m of [llmByDate, researchByDate, voiceByDate]) {
			for (const k of m.keys()) if (k >= monthStart && k <= today) monthKeys.add(k);
		}
		let monthToDate = 0;
		for (const d of monthKeys) monthToDate += dateCost(d);

		const providers: SpendProviderRow[] = Array.from(providerTotals.entries())
			.map(([provider, v]) => ({ provider, tokens: v.tokens, costUsd: round2(v.costUsd) }))
			.sort((a, b) => b.costUsd - a.costUsd);

		const caps = readCaps(providers);

		return {
			today: round2(dateCost(today)),
			monthToDate: round2(monthToDate),
			total: round2(windowLlm + windowResearch + windowVoice),
			categories: {
				chatLlm: round2(windowLlm),
				research: round2(windowResearch),
				voice: round2(windowVoice)
			},
			providers,
			dailyTrend,
			caps,
			note: NOTE
		};
	} catch (e) {
		console.error('getSpend error:', e);
		return emptyReport(n);
	} finally {
		db.close();
	}
}
