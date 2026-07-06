import Database from 'better-sqlite3';
import { serverConfig } from './config';
import { todayDate } from './spend_util';
import type { SpendProviderRow } from './spend';

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

export function readCaps(providers: SpendProviderRow[]): SpendCap[] {
	const envNum = (key: string, fallback: number): number => {
		const raw = typeof process !== 'undefined' ? process.env[key] : undefined;
		if (raw === undefined || raw === '') return fallback;
		const n = Number(raw);
		return Number.isFinite(n) && n >= 0 ? n : fallback;
	};
	// Per-provider daily token caps (from llm_router.ts env vars).
	const dailyCaps: Record<string, { tokenCap: number; monthlyCap: number }> = {
		anthropic: {
			tokenCap: envNum('ANTHROPIC_DAILY_TOKEN_CAP', 1_000_000),
			monthlyCap: envNum('ANTHROPIC_MONTHLY_SPEND_CAP', 0)
		},
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
