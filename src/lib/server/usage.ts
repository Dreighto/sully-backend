import fs from 'node:fs';
import Database from 'better-sqlite3';
import { serverConfig } from './config';
import { resolveWorker } from '$lib/config/workers';
import type {
	DailyUsage,
	HourlyBucket,
	TicketCost,
	UsageHistory,
	UsageMetrics,
	UsageProjection
} from '$lib/types/usage';

export type {
	UsageMetrics,
	UsageHistory,
	UsageProjection,
	DailyUsage,
	TicketCost,
	HourlyBucket
} from '$lib/types/usage';

// Module-level DB singleton — readwrite so we can maintain the usage_events
// table alongside the readonly provisional_lessons table. WAL mode lets the
// existing readonly connection in memory.ts coexist without contention.
let _db: Database.Database | null = null;
let _lastIngest = 0;
const INGEST_COOLDOWN_MS = 60_000;

function getDb(): Database.Database {
	if (_db) return _db;

	_db = new Database(serverConfig.memoryDbPath);
	_db.pragma('journal_mode = WAL');
	_db.pragma('synchronous = NORMAL');

	_db.exec(`
		CREATE TABLE IF NOT EXISTS usage_events (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			ts          TEXT    NOT NULL,
			date        TEXT    NOT NULL,
			worker      TEXT    NOT NULL,
			predicted_cost_usd   REAL    NOT NULL DEFAULT 0,
			predicted_tokens     INTEGER NOT NULL DEFAULT 0,
			trace_id    TEXT    UNIQUE NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_usage_date   ON usage_events(date);
		CREATE INDEX IF NOT EXISTS idx_usage_ts     ON usage_events(ts);
		CREATE INDEX IF NOT EXISTS idx_usage_worker ON usage_events(worker);
	`);

	// Backfill entire log on first open so historical data is immediately available.
	ingestLog(_db);
	_lastIngest = Date.now();

	return _db;
}

// Reads the full worker log and upserts every hermes_predict_logged entry.
// INSERT OR IGNORE on trace_id makes repeated calls idempotent — safe to call
// at any time to pick up new entries without duplicating old ones.
function ingestLog(db: Database.Database): void {
	if (!fs.existsSync(serverConfig.workerLogPath)) return;

	const content = fs.readFileSync(serverConfig.workerLogPath, 'utf-8');
	const lines = content.split('\n');

	const upsert = db.prepare(`
		INSERT OR IGNORE INTO usage_events
			(ts, date, worker, predicted_cost_usd, predicted_tokens, trace_id)
		VALUES (?, ?, ?, ?, ?, ?)
	`);

	type Row = [string, string, string, number, number, string];

	const insertBatch = db.transaction((entries: Row[]) => {
		for (const e of entries) upsert.run(...e);
	});

	const entries: Row[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.msg !== 'hermes_predict_logged' || !entry.trace_id) continue;

			entries.push([
				entry.ts,
				(entry.ts as string).split('T')[0],
				entry.worker_dispatched || 'unknown',
				entry.predicted_cost_usd || 0,
				entry.predicted_total_tokens || 0,
				entry.trace_id
			]);
		} catch {
			// skip malformed lines
		}
	}

	if (entries.length > 0) insertBatch(entries);
}

function maybeIngest(db: Database.Database): void {
	const now = Date.now();
	if (now - _lastIngest < INGEST_COOLDOWN_MS) return;
	_lastIngest = now;
	ingestLog(db);
}

// Returns 24h rolling window metrics — same shape as before so the landing
// page component and existing API route need no changes.
export function getUsageMetrics(): UsageMetrics {
	try {
		const db = getDb();
		maybeIngest(db);

		const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		const rows = db
			.prepare(
				`
			SELECT worker,
			       ROUND(SUM(predicted_cost_usd), 4) as cost,
			       SUM(predicted_tokens)              as tokens,
			       COUNT(*)                           as count
			FROM usage_events
			WHERE ts >= ?
			GROUP BY worker
		`
			)
			.all(cutoff) as { worker: string; cost: number; tokens: number; count: number }[];

		const metrics: UsageMetrics = {
			totalPredictedCost: 0,
			totalPredictedTokens: 0,
			workerBreakdown: {},
			recentDispatches: 0
		};

		for (const row of rows) {
			metrics.totalPredictedCost += row.cost;
			metrics.totalPredictedTokens += row.tokens;
			metrics.recentDispatches += row.count;
			// Normalize the raw worker name to a registry id and merge variants
			// (e.g. 'claude-code' and 'claude-code-1' both fold into 'backend-1').
			const workerId = resolveWorker(row.worker)?.id ?? row.worker;
			const existing = metrics.workerBreakdown[workerId];
			if (existing) {
				existing.cost = Math.round((existing.cost + row.cost) * 10000) / 10000;
				existing.tokens += row.tokens;
				existing.count += row.count;
			} else {
				metrics.workerBreakdown[workerId] = {
					cost: row.cost,
					tokens: row.tokens,
					count: row.count
				};
			}
		}

		metrics.totalPredictedCost = Math.round(metrics.totalPredictedCost * 10000) / 10000;
		return metrics;
	} catch {
		return {
			totalPredictedCost: 0,
			totalPredictedTokens: 0,
			workerBreakdown: {},
			recentDispatches: 0
		};
	}
}

// Returns per-day usage breakdown for the last `days` calendar days plus an
// end-of-month cost projection based on the current month's daily average.
export function getUsageHistory(days = 30): UsageHistory {
	try {
		const db = getDb();
		maybeIngest(db);

		// Per-worker daily rows for the requested window
		const rows = db
			.prepare(
				`
			SELECT date, worker,
			       ROUND(SUM(predicted_cost_usd), 4) as cost,
			       SUM(predicted_tokens)              as tokens,
			       COUNT(*)                           as dispatches
			FROM usage_events
			WHERE date >= date('now', ?)
			GROUP BY date, worker
			ORDER BY date DESC, worker
		`
			)
			.all(`-${days} days`) as {
			date: string;
			worker: string;
			cost: number;
			tokens: number;
			dispatches: number;
		}[];

		// Group into per-day buckets
		const byDate = new Map<string, DailyUsage>();
		for (const row of rows) {
			if (!byDate.has(row.date)) {
				byDate.set(row.date, {
					date: row.date,
					workers: [],
					totalCost: 0,
					totalTokens: 0,
					totalDispatches: 0
				});
			}
			const day = byDate.get(row.date)!;
			// Fold the raw worker name into its registry id, merging variants.
			const workerId = resolveWorker(row.worker)?.id ?? row.worker;
			let wu = day.workers.find((w) => w.worker === workerId);
			if (!wu) {
				wu = { worker: workerId, cost: 0, tokens: 0, dispatches: 0 };
				day.workers.push(wu);
			}
			wu.cost = Math.round((wu.cost + row.cost) * 10000) / 10000;
			wu.tokens += row.tokens;
			wu.dispatches += row.dispatches;
			day.totalCost = Math.round((day.totalCost + row.cost) * 10000) / 10000;
			day.totalTokens += row.tokens;
			day.totalDispatches += row.dispatches;
		}

		// Month-to-date totals for projection
		const now = new Date();
		const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

		const mtdRows = db
			.prepare(
				`
			SELECT worker, ROUND(SUM(predicted_cost_usd), 4) as cost
			FROM usage_events
			WHERE date >= ?
			GROUP BY worker
		`
			)
			.all(firstOfMonth) as { worker: string; cost: number }[];

		let monthToDate = 0;
		const byWorker: Record<string, number> = {};
		for (const r of mtdRows) {
			monthToDate += r.cost;
			const workerId = resolveWorker(r.worker)?.id ?? r.worker;
			byWorker[workerId] = Math.round(((byWorker[workerId] ?? 0) + r.cost) * 10000) / 10000;
		}
		monthToDate = Math.round(monthToDate * 10000) / 10000;

		const daysElapsed = now.getDate();
		const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
		const dailyAvg = daysElapsed > 0 ? monthToDate / daysElapsed : 0;
		const projectedEOM = Math.round(dailyAvg * daysInMonth * 100) / 100;

		const projection: UsageProjection = {
			monthToDate,
			byWorker,
			daysElapsed,
			daysInMonth,
			dailyAvg: Math.round(dailyAvg * 10000) / 10000,
			projectedEOM
		};

		const { n } = db.prepare('SELECT COUNT(*) as n FROM usage_events').get() as { n: number };

		return {
			days: Array.from(byDate.values()),
			projection,
			totalEvents: n
		};
	} catch {
		const now = new Date();
		return {
			days: [],
			projection: {
				monthToDate: 0,
				byWorker: {},
				daysElapsed: now.getDate(),
				daysInMonth: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
				dailyAvg: 0,
				projectedEOM: 0
			},
			totalEvents: 0
		};
	}
}

// Per-ticket cost leaderboard — joins usage_events with observations on trace_id
// so each dispatch is attributed to the ticket that generated it.
// Uses a CTE to deduplicate observations (one trace may have multiple observation rows).
export function getTicketLeaderboard(days = 30): TicketCost[] {
	try {
		const db = getDb();
		maybeIngest(db);

		const rows = db
			.prepare(
				`
			WITH ticket_traces AS (
				SELECT trace_id, MIN(ticket_id) AS ticket_id
				FROM observations
				WHERE ticket_id IS NOT NULL
				GROUP BY trace_id
			),
			ticket_worker_costs AS (
				SELECT tt.ticket_id, u.worker,
				       COUNT(u.trace_id)                    AS dispatches,
				       ROUND(SUM(u.predicted_cost_usd), 4)  AS cost,
				       SUM(u.predicted_tokens)               AS tokens
				FROM ticket_traces tt
				JOIN usage_events u ON tt.trace_id = u.trace_id
				WHERE u.date >= date('now', ?)
				GROUP BY tt.ticket_id, u.worker
			),
			top_tickets AS (
				SELECT ticket_id
				FROM ticket_worker_costs
				GROUP BY ticket_id
				ORDER BY SUM(cost) DESC
				LIMIT 10
			)
			SELECT twc.ticket_id, twc.worker, twc.dispatches, twc.cost, twc.tokens
			FROM ticket_worker_costs twc
			JOIN top_tickets tt ON twc.ticket_id = tt.ticket_id
			ORDER BY twc.cost DESC
		`
			)
			.all(`-${days} days`) as TicketCost[];

		return rows;
	} catch {
		return [];
	}
}

// Hour-of-day × date activity buckets for the heatmap.
// ts is stored as ISO 8601 UTC; strftime extracts the UTC hour.
export function getHourlyActivity(days = 14): HourlyBucket[] {
	try {
		const db = getDb();
		maybeIngest(db);

		const rows = db
			.prepare(
				`
			SELECT date,
			       CAST(strftime('%H', ts) AS INTEGER) AS hour,
			       ROUND(SUM(predicted_cost_usd), 4)   AS cost,
			       COUNT(*)                             AS dispatches
			FROM usage_events
			WHERE date >= date('now', ?)
			GROUP BY date, hour
			ORDER BY date, hour
		`
			)
			.all(`-${days} days`) as HourlyBucket[];

		return rows;
	} catch {
		return [];
	}
}
