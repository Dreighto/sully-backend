// One-way dependency: this module imports getSpend from './spend' (the core
// aggregator). Do NOT reverse this — spend.ts must never import from here, or
// it becomes circular. getAlerts is a CONSUMER of the spend report, not part
// of computing it.
import { getSpend } from './spend';

export interface SpendAlert {
	severity: 'info' | 'warning' | 'critical';
	provider: string;
	message: string;
	pct: number;
}

export function getAlerts(): SpendAlert[] {
	const report = getSpend(30);
	const alerts: SpendAlert[] = [];

	for (const cap of report.caps) {
		if (cap.dailyTokenCap > 0) {
			const pct = cap.todayTokens / cap.dailyTokenCap;
			if (pct >= 1) {
				alerts.push({
					severity: 'critical',
					provider: cap.provider,
					message: `${cap.provider} daily token cap reached (${formatTokens(cap.todayTokens)} / ${formatTokens(cap.dailyTokenCap)})`,
					pct: 1
				});
			} else if (pct >= 0.85) {
				alerts.push({
					severity: 'warning',
					provider: cap.provider,
					message: `${cap.provider} at ${Math.round(pct * 100)}% of daily token cap (${formatTokens(cap.todayTokens)} / ${formatTokens(cap.dailyTokenCap)})`,
					pct
				});
			} else if (pct >= 0.7) {
				alerts.push({
					severity: 'info',
					provider: cap.provider,
					message: `${cap.provider} at ${Math.round(pct * 100)}% of daily token cap`,
					pct
				});
			}
		}
		if (cap.monthlySpendCap > 0) {
			const pct = cap.monthToDate / cap.monthlySpendCap;
			if (pct >= 1) {
				alerts.push({
					severity: 'critical',
					provider: cap.provider,
					message: `${cap.provider} monthly spend cap reached ($${cap.monthToDate.toFixed(2)} / $${cap.monthlySpendCap.toFixed(2)})`,
					pct: 1
				});
			} else if (pct >= 0.85) {
				alerts.push({
					severity: 'warning',
					provider: cap.provider,
					message: `${cap.provider} at ${Math.round(pct * 100)}% of monthly spend cap`,
					pct
				});
			}
		}
	}

	return alerts;
}

function formatTokens(t: number): string {
	if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
	if (t >= 1_000) return `${(t / 1_000).toFixed(0)}K`;
	return `${t}`;
}
