import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-dispatch-tokens-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DISPATCH_ENABLED: 'true'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	const db = new Database(DB);
	db.exec(`
		CREATE TABLE worker_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			trace_id TEXT NOT NULL UNIQUE,
			worker TEXT NOT NULL,
			outcome TEXT,
			duration_ms INTEGER,
			started_at TEXT NOT NULL,
			task_shape TEXT,
			input_tokens INTEGER,
			output_tokens INTEGER,
			cached_input_tokens INTEGER,
			reasoning_tokens INTEGER,
			usage_source TEXT
		);
		CREATE TABLE pending_jobs (
			trace_id TEXT UNIQUE NOT NULL,
			title TEXT,
			brief TEXT NOT NULL DEFAULT '',
			predicted_tokens INTEGER NOT NULL DEFAULT 0,
			thread_id TEXT
		);
	`);
	db.prepare(
		`INSERT INTO worker_runs
		 (trace_id, worker, outcome, duration_ms, started_at, task_shape,
		  input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, usage_source)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		'trace-1',
		'claude-code',
		'CONFIRMED_WORKING',
		1200,
		'2026-06-12T10:00:00.000Z',
		'code',
		100,
		50,
		25,
		5,
		'worker_runs'
	);
	db.prepare(
		`INSERT INTO worker_runs
		 (trace_id, worker, outcome, duration_ms, started_at, task_shape,
		  input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, usage_source)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		'trace-2',
		'claude-code',
		'CONFIRMED_WORKING',
		1300,
		'2026-06-12T11:00:00.000Z',
		'code',
		300,
		100,
		50,
		10,
		'worker_runs'
	);
	db.prepare(
		`INSERT INTO worker_runs
		 (trace_id, worker, outcome, duration_ms, started_at, task_shape,
		  input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, usage_source)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		'trace-3',
		'agy',
		'FAILED',
		900,
		'2026-06-12T12:00:00.000Z',
		'ui',
		null,
		null,
		null,
		null,
		'unavailable'
	);
	db.prepare(
		`INSERT INTO pending_jobs (trace_id, title, brief, predicted_tokens, thread_id)
		 VALUES (?, ?, ?, ?, ?)`
	).run('trace-1', 'Fix build', 'fallback', 1000, 'thread-a');
	db.prepare(
		`INSERT INTO pending_jobs (trace_id, title, brief, predicted_tokens, thread_id)
		 VALUES (?, ?, ?, ?, ?)`
	).run('trace-3', null, 'Visual pass', 2000, 'thread-b');
	db.close();
	vi.resetModules();
});

afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

describe('/api/chat/dispatch/tokens', () => {
	it('aggregates measured worker_runs and keeps unavailable usage null per run', async () => {
		const { GET } = await import('../src/routes/api/chat/dispatch/tokens/+server');
		const response = await GET({
			url: new URL('http://localhost/api/chat/dispatch/tokens?window=all')
		} as never);
		const body = await response.json();

		expect(body.enabled).toBe(true);
		expect(body.totals).toMatchObject({
			runs: 3,
			runsWithUsage: 2,
			runsMissingUsage: 1,
			tokensIn: 400,
			tokensOut: 150,
			tokensCached: 75,
			tokensReasoning: 15,
			tokensTotal: 640
		});
		expect(body.byWorker[0]).toMatchObject({
			worker: 'claude-code',
			brandColor: '#d97757',
			runs: 2,
			runsWithUsage: 2,
			tokensTotal: 640,
			avgTotalPerRun: 320,
			medianTotalPerRun: 320,
			maxTotalPerRun: 460
		});
		const unmeasuredWorker = body.byWorker.find(
			(worker: { worker: string }) => worker.worker === 'agy'
		);
		expect(unmeasuredWorker).toMatchObject({
			runs: 1,
			runsWithUsage: 0,
			tokensTotal: null,
			costUsd: null,
			avgTotalPerRun: null,
			medianTotalPerRun: null,
			maxTotalPerRun: null
		});
		const unmeasured = body.recentRuns.find(
			(run: { traceId: string }) => run.traceId === 'trace-3'
		);
		expect(unmeasured).toMatchObject({
			worker: 'agy',
			brandColor: '#a855f7',
			title: 'Visual pass',
			tokensIn: null,
			tokensOut: null,
			tokensCached: null,
			tokensReasoning: null,
			tokensTotal: null,
			costUsd: null
		});
	});

	it('returns enabled:false when companion dispatch is disabled', async () => {
		ENV.COMPANION_DISPATCH_ENABLED = 'false';
		vi.resetModules();
		const { GET } = await import('../src/routes/api/chat/dispatch/tokens/+server');
		const response = await GET({
			url: new URL('http://localhost/api/chat/dispatch/tokens')
		} as never);
		expect(await response.json()).toMatchObject({ enabled: false, window: '7d' });
		ENV.COMPANION_DISPATCH_ENABLED = 'true';
	});
});
