// Shape test for the READ-ONLY verification exposure (verification-exposure).
// buildVerificationView() surfaces per-channel {name, verdict} + overall posture
// from the pending_jobs verification_* columns that verifyPoll/completionClose
// already wrote — no new verification logic, so the test is about SHAPE + the
// degrade paths (poll never ran, malformed evidence JSON), plus the DB-backed
// path through liveSurfaceFromTrace().
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDb = join(tmpdir(), `verification-exposure-test-${Date.now()}.db`);
const storeRootDir = fs.mkdtempSync(join(tmpdir(), 've-store-'));
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_MEMORY_DB_PATH: tmpDb,
		LOGUEOS_ARTIFACT_REPO_ROOT: storeRootDir
	}
}));

// Dynamic import after setting env (same pattern as surface-adapter.test.ts).
const { buildVerificationView, liveSurfaceFromTrace } = await import('$lib/server/surfaceAdapter');

// Evidence exactly as completionClose stores it: JSON.stringify(poll.channels)
// where each entry is a verifyPoll ChannelResult.
const storedChannels = [
	{ channel: 'worker_completion', critical: true, state: 'GO', liveness: true, detail: 'exit 0' },
	{ channel: 'task_state', critical: true, state: 'GO', liveness: true },
	{ channel: 'git_commit', critical: true, state: 'NO_GO', detail: 'commit not found' },
	{ channel: 'artifact', critical: false, state: 'SKIPPED' },
	{ channel: 'pr', critical: false, state: 'UNKNOWN' }
];

describe('buildVerificationView (pure shape)', () => {
	it('maps stored channels to {name, verdict} + overall posture + ref', () => {
		const view = buildVerificationView({
			verification_state: 'warn',
			verification_ref: 'abc123',
			verification_evidence: JSON.stringify(storedChannels)
		});
		expect(view).toBeDefined();
		expect(view!.overall).toBe('warn');
		expect(view!.ref).toBe('abc123');
		expect(view!.channels).toHaveLength(5);
		// Every channel entry has exactly the exposed shape...
		for (const ch of view!.channels) {
			expect(typeof ch.name).toBe('string');
			expect(['GO', 'NO_GO', 'UNKNOWN', 'SKIPPED']).toContain(ch.verdict);
			// READ-ONLY view — internal ChannelResult fields must NOT leak through.
			expect(ch).not.toHaveProperty('critical');
			expect(ch).not.toHaveProperty('liveness');
			expect(ch).not.toHaveProperty('evidence_pointer');
		}
		// ...and verdicts mirror the stored states verbatim.
		expect(view!.channels.map((c) => [c.name, c.verdict])).toEqual([
			['worker_completion', 'GO'],
			['task_state', 'GO'],
			['git_commit', 'NO_GO'],
			['artifact', 'SKIPPED'],
			['pr', 'UNKNOWN']
		]);
		// detail passes through when present.
		expect(view!.channels[2].detail).toBe('commit not found');
	});

	it('returns undefined when the poll never ran (verification_state null)', () => {
		expect(
			buildVerificationView({
				verification_state: null,
				verification_ref: null,
				verification_evidence: null
			})
		).toBeUndefined();
		expect(buildVerificationView(null)).toBeUndefined();
		expect(buildVerificationView(undefined)).toBeUndefined();
	});

	it('degrades to posture-only on malformed or non-array evidence, never throws', () => {
		const malformed = buildVerificationView({
			verification_state: 'confirmed',
			verification_ref: null,
			verification_evidence: '{not json'
		});
		expect(malformed).toEqual({ overall: 'confirmed', channels: [], ref: null });

		const nonArray = buildVerificationView({
			verification_state: 'hedge',
			verification_ref: null,
			verification_evidence: '{"channel":"x","state":"GO"}'
		});
		expect(nonArray!.channels).toEqual([]);
	});

	it('coerces an unrecognized stored state to UNKNOWN rather than inventing a verdict', () => {
		const view = buildVerificationView({
			verification_state: 'confirmed',
			verification_ref: null,
			verification_evidence: JSON.stringify([{ channel: 'weird', state: 'MAYBE' }])
		});
		expect(view!.channels).toEqual([{ name: 'weird', verdict: 'UNKNOWN' }]);
	});
});

describe('liveSurfaceFromTrace verification exposure (DB-backed)', () => {
	beforeAll(() => {
		const db = new Database(tmpDb);
		db.exec(`
            CREATE TABLE pending_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trace_id TEXT UNIQUE NOT NULL,
                worker TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'decided',
                current_activity TEXT,
                started_at TEXT DEFAULT CURRENT_TIMESTAMP,
                ended_at TEXT,
                result_ref TEXT,
                brief TEXT NOT NULL DEFAULT '',
                thread_id TEXT,
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
		db.prepare(
			`INSERT INTO pending_jobs
               (trace_id, worker, status, brief, started_at, ended_at,
                verification_state, verification_ref, verification_evidence)
             VALUES ('trace-verified', 'claude-code', 'synthesized', 'Verified task', ?, ?, 'confirmed', 'deadbeef', ?)`
		).run(
			new Date(Date.now() - 600000).toISOString(),
			new Date(Date.now() - 30000).toISOString(),
			JSON.stringify(storedChannels.slice(0, 2))
		);
		db.prepare(
			`INSERT INTO pending_jobs (trace_id, worker, status, brief, started_at)
             VALUES ('trace-unverified', 'claude-code', 'working', 'Unverified task', ?)`
		).run(new Date(Date.now() - 60000).toISOString());
		db.close();
	});

	afterAll(() => {
		try {
			fs.unlinkSync(tmpDb);
		} catch {
			/* already gone */
		}
		fs.rmSync(storeRootDir, { recursive: true, force: true });
	});

	it('includes the verification block on a verified task surface', async () => {
		const surface = await liveSurfaceFromTrace('trace-verified');
		expect(surface).not.toBeNull();
		expect(surface!.verification).toEqual({
			overall: 'confirmed',
			ref: 'deadbeef',
			channels: [
				{ name: 'worker_completion', verdict: 'GO', detail: 'exit 0' },
				{ name: 'task_state', verdict: 'GO' }
			]
		});
	});

	it('omits verification entirely when the poll has not run', async () => {
		const surface = await liveSurfaceFromTrace('trace-unverified');
		expect(surface).not.toBeNull();
		expect(surface!.verification).toBeUndefined();
	});
});
