import fs from 'node:fs';
import Database from 'better-sqlite3';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runMode, serverConfig } from '$lib/server/config';
import { workerBrandColor } from '$lib/utils/workerVisual';

type WindowParam = 'today' | '7d' | '30d' | 'all';

interface TokenRunRow {
	traceId: string;
	worker: string;
	outcome: string | null;
	durationMs: number | null;
	startedAt: string;
	taskShape: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedInputTokens: number | null;
	reasoningTokens: number | null;
	usageSource: string | null;
	title: string | null;
	brief: string | null;
	predictedTokens: number | null;
	threadId: string | null;
}

interface NormalizedRun {
	traceId: string;
	worker: string;
	brandColor: string;
	title: string | null;
	taskShape: string | null;
	outcome: string | null;
	durationMs: number | null;
	tokensIn: number | null;
	tokensOut: number | null;
	tokensCached: number | null;
	tokensReasoning: number | null;
	tokensTotal: number | null;
	costUsd: number | null;
	predictedTokens: number | null;
	startedAt: string;
}

const WINDOW_VALUES: WindowParam[] = ['today', '7d', '30d', 'all'];
const ESTIMATED_USD_PER_M_TOKEN = 1;

function parseWindow(raw: string | null): WindowParam {
	return WINDOW_VALUES.includes(raw as WindowParam) ? (raw as WindowParam) : '7d';
}

function windowWhere(window: WindowParam): string {
	switch (window) {
		case 'today':
			return "date(wr.started_at) = date('now')";
		case '7d':
			return "datetime(wr.started_at) >= datetime('now', '-7 days')";
		case '30d':
			return "datetime(wr.started_at) >= datetime('now', '-30 days')";
		case 'all':
			return '1 = 1';
	}
}

function tableColumns(db: Database.Database, table: string): Set<string> {
	try {
		return new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name));
	} catch {
		return new Set();
	}
}

function col(cols: Set<string>, tableAlias: string, name: string, fallback = 'NULL'): string {
	return cols.has(name) ? `${tableAlias}.${name}` : fallback;
}

function measured(row: TokenRunRow): boolean {
	return row.usageSource !== null && row.usageSource !== 'unavailable';
}

function numberOrZero(value: number | null): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function estimateCostUsd(tokensTotal: number): number {
	// Worker model pricing is not recorded in worker_runs. This is a display-only
	// estimate using the same simple $1/M token shape used by local budget tests.
	return roundUsd((tokensTotal / 1_000_000) * ESTIMATED_USD_PER_M_TOKEN);
}

function roundUsd(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid];
	return (sorted[mid - 1] + sorted[mid]) / 2;
}

function normalizeRun(row: TokenRunRow): NormalizedRun {
	const hasUsage = measured(row);
	const tokensIn = hasUsage ? numberOrZero(row.inputTokens) : null;
	const tokensOut = hasUsage ? numberOrZero(row.outputTokens) : null;
	const tokensCached = hasUsage ? numberOrZero(row.cachedInputTokens) : null;
	const tokensReasoning = hasUsage ? numberOrZero(row.reasoningTokens) : null;
	const tokensTotal = hasUsage ? tokensIn! + tokensOut! + tokensCached! + tokensReasoning! : null;
	return {
		traceId: row.traceId,
		worker: row.worker,
		brandColor: workerBrandColor(row.worker),
		title: row.title || row.brief || null,
		taskShape: row.taskShape,
		outcome: row.outcome,
		durationMs: row.durationMs,
		tokensIn,
		tokensOut,
		tokensCached,
		tokensReasoning,
		tokensTotal,
		costUsd: tokensTotal === null ? null : estimateCostUsd(tokensTotal),
		predictedTokens: row.predictedTokens,
		startedAt: row.startedAt
	};
}

function emptyResponse(window: WindowParam) {
	return {
		enabled: true,
		window,
		generatedAt: new Date().toISOString(),
		totals: {
			runs: 0,
			tokensIn: 0,
			tokensOut: 0,
			tokensCached: 0,
			tokensReasoning: 0,
			tokensTotal: 0,
			costUsd: 0,
			runsWithUsage: 0,
			runsMissingUsage: 0
		},
		byWorker: [],
		byDay: [],
		recentRuns: []
	};
}

function buildTokenSpendResponse(rows: TokenRunRow[], window: WindowParam) {
	const runs = rows.map(normalizeRun);
	const measuredRuns = runs.filter((r) => r.tokensTotal !== null);
	const sum = (
		field: keyof Pick<
			NormalizedRun,
			'tokensIn' | 'tokensOut' | 'tokensCached' | 'tokensReasoning' | 'tokensTotal'
		>
	) => measuredRuns.reduce((total, run) => total + (run[field] ?? 0), 0);
	const tokensTotal = sum('tokensTotal');

	const byWorkerMap = new Map<string, NormalizedRun[]>();
	for (const run of runs) {
		const list = byWorkerMap.get(run.worker) ?? [];
		list.push(run);
		byWorkerMap.set(run.worker, list);
	}

	const byWorker = [...byWorkerMap.entries()]
		.map(([worker, workerRuns]) => {
			const workerMeasured = workerRuns.filter((r) => r.tokensTotal !== null);
			const totals = workerMeasured.map((r) => r.tokensTotal as number);
			const workerTotal = totals.reduce((total, value) => total + value, 0);
			const workerMedian = median(totals);
			const maxTotal = totals.length > 0 ? Math.max(...totals) : 0;
			const factor = workerMedian && workerMedian > 0 ? maxTotal / workerMedian : 0;
			const flagged = factor >= 2;
			const hasMeasuredUsage = workerMeasured.length > 0;
			return {
				worker,
				brandColor: workerBrandColor(worker),
				runs: workerRuns.length,
				runsWithUsage: workerMeasured.length,
				tokensIn: hasMeasuredUsage
					? workerMeasured.reduce((total, run) => total + (run.tokensIn ?? 0), 0)
					: null,
				tokensOut: hasMeasuredUsage
					? workerMeasured.reduce((total, run) => total + (run.tokensOut ?? 0), 0)
					: null,
				tokensCached: hasMeasuredUsage
					? workerMeasured.reduce((total, run) => total + (run.tokensCached ?? 0), 0)
					: null,
				tokensReasoning: hasMeasuredUsage
					? workerMeasured.reduce((total, run) => total + (run.tokensReasoning ?? 0), 0)
					: null,
				tokensTotal: hasMeasuredUsage ? workerTotal : null,
				costUsd: hasMeasuredUsage ? estimateCostUsd(workerTotal) : null,
				avgTotalPerRun: hasMeasuredUsage ? Math.round(workerTotal / workerMeasured.length) : null,
				medianTotalPerRun: workerMedian,
				maxTotalPerRun: hasMeasuredUsage ? maxTotal : null,
				overuse: {
					flagged,
					factor: flagged ? Math.round(factor * 100) / 100 : null,
					reason: flagged
						? `Max measured run is ${Math.round(factor * 100) / 100}x this worker's median.`
						: null
				}
			};
		})
		.sort((a, b) => (b.tokensTotal ?? 0) - (a.tokensTotal ?? 0));

	const byDayMap = new Map<string, { tokensTotal: number; costUsd: number }>();
	for (const run of measuredRuns) {
		const date = run.startedAt.slice(0, 10);
		const day = byDayMap.get(date) ?? { tokensTotal: 0, costUsd: 0 };
		day.tokensTotal += run.tokensTotal ?? 0;
		day.costUsd += run.costUsd ?? 0;
		byDayMap.set(date, day);
	}
	const byDay = [...byDayMap.entries()]
		.map(([date, day]) => ({
			date,
			tokensTotal: day.tokensTotal,
			costUsd: roundUsd(day.costUsd)
		}))
		.sort((a, b) => a.date.localeCompare(b.date));

	return {
		enabled: true,
		window,
		generatedAt: new Date().toISOString(),
		totals: {
			runs: runs.length,
			tokensIn: sum('tokensIn'),
			tokensOut: sum('tokensOut'),
			tokensCached: sum('tokensCached'),
			tokensReasoning: sum('tokensReasoning'),
			tokensTotal,
			costUsd: estimateCostUsd(tokensTotal),
			runsWithUsage: measuredRuns.length,
			runsMissingUsage: runs.length - measuredRuns.length
		},
		byWorker,
		byDay,
		recentRuns: runs.slice(0, 50)
	};
}

function readRows(
	db: Database.Database,
	window: WindowParam,
	worker: string | null,
	traceId: string | null
) {
	const workerCols = tableColumns(db, 'worker_runs');
	if (!workerCols.has('trace_id')) return [];
	const pendingCols = tableColumns(db, 'pending_jobs');
	const where = [windowWhere(window)];
	const args: string[] = [];
	if (worker) {
		where.push('wr.worker = ?');
		args.push(worker);
	}
	if (traceId) {
		where.push('wr.trace_id = ?');
		args.push(traceId);
	}
	return db
		.prepare(
			`SELECT
				wr.trace_id AS traceId,
				wr.worker AS worker,
				${col(workerCols, 'wr', 'outcome')} AS outcome,
				${col(workerCols, 'wr', 'duration_ms')} AS durationMs,
				wr.started_at AS startedAt,
				${col(workerCols, 'wr', 'task_shape')} AS taskShape,
				${col(workerCols, 'wr', 'input_tokens')} AS inputTokens,
				${col(workerCols, 'wr', 'output_tokens')} AS outputTokens,
				${col(workerCols, 'wr', 'cached_input_tokens')} AS cachedInputTokens,
				${col(workerCols, 'wr', 'reasoning_tokens')} AS reasoningTokens,
				${col(workerCols, 'wr', 'usage_source')} AS usageSource,
				${col(pendingCols, 'p', 'title')} AS title,
				${col(pendingCols, 'p', 'brief')} AS brief,
				${col(pendingCols, 'p', 'predicted_tokens')} AS predictedTokens,
				${col(pendingCols, 'p', 'thread_id')} AS threadId
			 FROM worker_runs wr
			 LEFT JOIN pending_jobs p ON p.trace_id = wr.trace_id
			 WHERE ${where.join(' AND ')}
			 ORDER BY datetime(wr.started_at) DESC, wr.id DESC`
		)
		.all(...args) as TokenRunRow[];
}

export const GET: RequestHandler = async ({ url }) => {
	const window = parseWindow(url.searchParams.get('window'));
	if (!runMode.companionDispatchEnabled) {
		return json({ enabled: false, window });
	}
	if (!fs.existsSync(serverConfig.kernelDbPath)) {
		return json(emptyResponse(window));
	}

	const worker = (url.searchParams.get('worker') || '').trim() || null;
	const traceId = (url.searchParams.get('trace_id') || '').trim() || null;
	const db = new Database(serverConfig.kernelDbPath, { readonly: true, fileMustExist: true });
	try {
		const rows = readRows(db, window, worker, traceId);
		return json(buildTokenSpendResponse(rows, window));
	} catch {
		return json(emptyResponse(window));
	} finally {
		db.close();
	}
};
