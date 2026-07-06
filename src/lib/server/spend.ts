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
//
// Wave 2 split (2026-07-06): budget -> spend_budget.ts, caps -> spend_caps.ts,
// alerts -> spend_alerts.ts, date/rounding helpers -> spend_util.ts. This file
// is kept as the core aggregator (getSpend) + a re-export barrel for the 3
// external route callers.

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';
import { tokenCostUsd, ttsCostUsd, sttCostUsd } from './pricing';
import { todayDate, shiftDate, round2, normalizeDays, safeAll } from './spend_util';
import { readCaps, type SpendCap } from './spend_caps';

export { getBudget, setBudget } from './spend_budget';
export { getAlerts, type SpendAlert } from './spend_alerts';
export { type SpendCap } from './spend_caps';

export interface SpendProviderRow {
	provider: string;
	tokens: number;
	costUsd: number;
}

export interface SpendModelRow {
	model: string;
	provider: string;
	tokens: number;
	costUsd: number;
}

export interface SpendReport {
	today: number;
	monthToDate: number;
	total: number;
	categories: { chatLlm: number; research: number; voice: number };
	providers: SpendProviderRow[];
	models: SpendModelRow[];
	dailyTrend: Array<{ date: string; cost: number }>;
	caps: SpendCap[];
	note: string;
}

const NOTE =
	'chatLlm is an ESTIMATE (blended per-provider token rates; override via ' +
	'LOGUEOS_PRICE_<PROVIDER>_PER_M). research is EXACT (real cents billed by ' +
	'Perplexity). voice uses configured TTS/STT rates (STT default $0, Jetson-local).';

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
		models: [],
		dailyTrend,
		caps: [],
		note: NOTE
	};
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
		const tokenRows = safeAll<{
			date: string;
			provider: string;
			model: string | null;
			tokens_used: number;
		}>(
			db,
			'SELECT date, provider, model, tokens_used FROM chat_token_usage WHERE date >= ?',
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
		// Per-model rollup (model column added 2026-07-04; older rows have null).
		const modelTotals = new Map<
			string,
			{ model: string; provider: string; tokens: number; costUsd: number }
		>();

		for (const r of tokenRows) {
			const cost = tokenCostUsd(r.provider, r.tokens_used, r.model);
			llmByDate.set(r.date, (llmByDate.get(r.date) ?? 0) + cost);
			if (r.date >= windowStart) {
				const cur = providerTotals.get(r.provider) ?? { tokens: 0, costUsd: 0 };
				cur.tokens += Number.isFinite(r.tokens_used) ? r.tokens_used : 0;
				cur.costUsd += cost;
				providerTotals.set(r.provider, cur);

				// Per-model: key on model name or fall back to provider.
				const modelKey = r.model || r.provider;
				const mc = modelTotals.get(modelKey) ?? {
					model: modelKey,
					provider: r.provider,
					tokens: 0,
					costUsd: 0
				};
				mc.tokens += Number.isFinite(r.tokens_used) ? r.tokens_used : 0;
				mc.costUsd += cost;
				modelTotals.set(modelKey, mc);
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

		const models: SpendModelRow[] = Array.from(modelTotals.entries())
			.map(([, v]) => ({
				model: v.model,
				provider: v.provider,
				tokens: v.tokens,
				costUsd: round2(v.costUsd)
			}))
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
			models,
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
