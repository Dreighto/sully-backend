import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDb = join(tmpdir(), `surface-adapter-test-${Date.now()}.db`);
// Stage 4: buildFiles reads the durable manifest under artifactRepoRoot().
const storeRootDir = fs.mkdtempSync(join(tmpdir(), 'sa-store-'));
process.env.LOGUEOS_ARTIFACT_REPO_ROOT = storeRootDir;
const artifactsTrace = 'test-artifacts';
const artifactsStoreDir = join(storeRootDir, 'data/sully/artifacts/2026-06-07', artifactsTrace);
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_MEMORY_DB_PATH: tmpDb,
		LOGUEOS_ARTIFACT_REPO_ROOT: storeRootDir
	}
}));

// Dynamic import after setting env
const { liveSurfaceFromTrace } = await import('$lib/server/surfaceAdapter');

describe('liveSurfaceFromTrace', () => {
	beforeAll(() => {
		// Create a temporary database for testing
		const db = new Database(tmpDb);

		// Create tables
		db.exec(`
            CREATE TABLE pending_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trace_id TEXT UNIQUE NOT NULL,
                worker TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'decided',
                category TEXT NOT NULL DEFAULT 'general',
                current_activity TEXT,
                seq_cursor INTEGER NOT NULL DEFAULT 0,
                started_at TEXT DEFAULT CURRENT_TIMESTAMP,
                ended_at TEXT,
                predicted_tokens INTEGER NOT NULL DEFAULT 0,
                actual_prompt INTEGER,
                actual_completion INTEGER,
                actual_cache_read INTEGER,
                actual_cache_creation INTEGER,
                actual_total INTEGER,
                result_ref TEXT,
                brief TEXT NOT NULL DEFAULT '',
                fingerprint TEXT NOT NULL DEFAULT '',
                thread_id TEXT,
                source TEXT,
                classification_tier TEXT,
                classification_payload TEXT,
                verification_state TEXT,
                verification_ref TEXT,
                verification_evidence TEXT,
                synthesis_message_id INTEGER,
                ticket_id TEXT
            );
            
            CREATE TABLE chat_activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trace_id TEXT NOT NULL,
                action TEXT NOT NULL,
                target TEXT,
                payload TEXT,
                timestamp TEXT DEFAULT CURRENT_TIMESTAMP
            );
        `);

		// Insert test data
		const now = new Date().toISOString();
		const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

		// Running task
		db.prepare(
			`
            INSERT INTO pending_jobs (trace_id, worker, status, brief, started_at)
            VALUES ('test-running', 'claude-code', 'working', 'Test running task', ?)
        `
		).run(fiveMinutesAgo);

		db.prepare(
			`
            INSERT INTO chat_activity (trace_id, action, target, timestamp)
            VALUES 
            ('test-running', 'thinking', NULL, ?),
            ('test-running', 'tool_invoked', 'tool1', ?),
            ('test-running', 'tool_result', 'result1', ?),
            ('test-running', 'write_file', '/tmp/test.txt', ?)
        `
		).run(
			new Date(Date.now() - 300000).toISOString(),
			new Date(Date.now() - 240000).toISOString(),
			new Date(Date.now() - 180000).toISOString(),
			new Date(Date.now() - 120000).toISOString()
		);

		// Done task
		db.prepare(
			`
            INSERT INTO pending_jobs (trace_id, worker, status, brief, started_at, ended_at)
            VALUES ('test-done', 'claude-code', 'synthesized', 'Test done task', ?, ?)
        `
		).run(new Date(Date.now() - 600000).toISOString(), new Date(Date.now() - 30000).toISOString());

		db.prepare(
			`
            INSERT INTO chat_activity (trace_id, action, target, timestamp)
            VALUES 
            ('test-done', 'thinking', NULL, ?),
            ('test-done', 'write_file', '/tmp/done.txt', ?),
            ('test-done', 'complete', NULL, ?)
        `
		).run(
			new Date(Date.now() - 590000).toISOString(),
			new Date(Date.now() - 550000).toISOString(),
			new Date(Date.now() - 35000).toISOString()
		);

		// Failed task
		db.prepare(
			`
            INSERT INTO pending_jobs (trace_id, worker, status, brief, started_at, ended_at)
            VALUES ('test-failed', 'claude-code', 'failed', 'Test failed task', ?, ?)
        `
		).run(new Date(Date.now() - 300000).toISOString(), new Date(Date.now() - 10000).toISOString());

		db.prepare(
			`
            INSERT INTO chat_activity (trace_id, action, target, payload, timestamp)
            VALUES 
            ('test-failed', 'thinking', NULL, NULL, ?),
            ('test-failed', 'gate_evaluated', NULL, '{"action":"operator-cancelled","target":"test"}', ?)
        `
		).run(new Date(Date.now() - 290000).toISOString(), new Date(Date.now() - 15000).toISOString());

		// Artifacts task — done, with a durable manifest (Stage 4 read-side).
		// buildFiles derives the traceId from activity rows, so seed one.
		db.prepare(
			`INSERT INTO pending_jobs (trace_id, worker, status, brief, started_at, ended_at)
			 VALUES (?, 'claude-code', 'synthesized', 'Artifacts task', ?, ?)`
		).run(
			artifactsTrace,
			new Date(Date.now() - 600000).toISOString(),
			new Date(Date.now() - 30000).toISOString()
		);
		db.prepare(
			`INSERT INTO chat_activity (trace_id, action, target, timestamp) VALUES (?, 'created_artifact', 'report.md', ?)`
		).run(artifactsTrace, new Date(Date.now() - 40000).toISOString());

		fs.mkdirSync(artifactsStoreDir, { recursive: true });
		fs.writeFileSync(join(artifactsStoreDir, 'report.md'), '# Report\n');
		fs.writeFileSync(join(artifactsStoreDir, 'notes.txt'), 'notes\n');
		const mk = (original: string, type: string, importance: string) => ({
			created_by: 'CC',
			task_id: artifactsTrace,
			trace_id: artifactsTrace,
			timestamp: '2026-06-07T20:45:39Z',
			source_worker: 'claude-code',
			workspace_path: artifactsStoreDir,
			artifact_type: type,
			original_path: original,
			artifact_url: `/companion/api/artifacts/${artifactsTrace}/${original}`,
			label: original,
			importance
		});
		// secondary first on disk to prove buildFiles RE-orders by importance
		fs.writeFileSync(
			join(artifactsStoreDir, 'manifest.json'),
			JSON.stringify([mk('notes.txt', 'data', 'supporting'), mk('report.md', 'doc', 'primary')])
		);

		db.close();
	});

	afterAll(() => {
		if (fs.existsSync(tmpDb)) {
			fs.unlinkSync(tmpDb);
		}
		fs.rmSync(storeRootDir, { recursive: true, force: true });
	});

	it('buildFiles reads the durable manifest → SeedFile[] with importance, ordered primary first', async () => {
		const result = await liveSurfaceFromTrace(artifactsTrace);
		expect(result).not.toBeNull();
		expect(result?.files).toHaveLength(2);
		// importance ordering: primary (report.md) before supporting (notes.txt)
		expect(result?.files[0].path).toBe('report.md');
		expect(result?.files[0].importance).toBe('primary');
		expect(result?.files[0].label).toBe('report.md');
		expect(result?.files[0].status).toBe('available');
		expect(result?.files[1].path).toBe('notes.txt');
		expect(result?.files[1].importance).toBe('supporting');
	});

	it('no manifest → files: [] (no Result Files row)', async () => {
		const result = await liveSurfaceFromTrace('test-done');
		expect(result).not.toBeNull();
		expect(result?.files).toEqual([]);
	});

	it('should return null for non-existent trace', async () => {
		const result = await liveSurfaceFromTrace('nonexistent');
		expect(result).toBeNull();
	});

	it('should handle running task correctly', async () => {
		const result = await liveSurfaceFromTrace('test-running');
		expect(result).not.toBeNull();
		expect(result?.aggr).toBe('running');
		expect(result?.workers[0].currentStep).toBe('Writing a file');
		expect(result?.phases.some((p: any) => p.status === 'active')).toBe(true);
	});

	it('should handle done task correctly', async () => {
		const result = await liveSurfaceFromTrace('test-done');
		expect(result).not.toBeNull();
		expect(result?.aggr).toBe('done');
		expect(result?.workers[0].status).toBe('done');
		expect(result?.phases.every((p: any) => p.status === 'done' || p.status === 'skipped')).toBe(
			true
		);
	});

	it('should handle failed task correctly', async () => {
		const result = await liveSurfaceFromTrace('test-failed');
		expect(result).not.toBeNull();
		expect(result?.aggr).toBe('failed');
		expect(result?.workers[0].status).toBe('failed');
		expect(result?.needs).toBeUndefined();
	});

	it('should handle task with zero activity rows', async () => {
		// Insert a task with no activity
		const db = new Database(tmpDb);
		db.prepare(
			`
            INSERT INTO pending_jobs (trace_id, worker, status, brief, started_at)
            VALUES ('test-no-activity', 'claude-code', 'working', 'No activity task', ?)
        `
		).run(new Date().toISOString());
		db.close();

		const result = await liveSurfaceFromTrace('test-no-activity');
		expect(result).not.toBeNull();
		expect(result?.workers[0].currentStep).toBe('starting');
		expect(result?.phases[0].status).toBe('active'); // Read phase should be active
	});
});
