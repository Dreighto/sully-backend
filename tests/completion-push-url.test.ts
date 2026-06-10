// Tests that the completion push URL carries the thread id so a tap opens the
// right conversation instead of a brand-new chat (the deep-link fix).
//
// Strategy: mock sendPushToAll + sendApnsToAll to capture what payload they're
// called with, then assert the url field contains ?thread=<id>.
// Both modules are self-gating in production (no-op until creds exist) so
// mocking them here is the only deterministic way to assert the payload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB = path.join(os.tmpdir(), 'sully-push-url-test.db');
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DISPATCH_ENABLED: 'true'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

// Synthesis is an LLM call — always return null (raw fallback) in this test.
vi.mock('$lib/server/routing/synthesize', () => ({
	synthesizeWorkerResult: vi.fn(async () => null)
}));

// Capture the payloads sent to web push + APNs.
const webPushPayloads: unknown[] = [];
const apnsPayloads: unknown[] = [];

vi.mock('$lib/server/web_push', () => ({
	sendPushToAll: vi.fn(async (payload: unknown) => {
		webPushPayloads.push(payload);
	})
}));

vi.mock('$lib/server/apns', () => ({
	sendApnsToAll: vi.fn(async (payload: unknown) => {
		apnsPayloads.push(payload);
		return { sent: 0, failed: 0 };
	}),
	apnsConfigured: vi.fn(() => false)
}));

function wipe() {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	webPushPayloads.length = 0;
	apnsPayloads.length = 0;
}

beforeEach(() => {
	wipe();
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	wipe();
});

describe('completion push URL carries thread id (deep-link fix)', () => {
	it('completionClose: push URL contains ?thread=<id> for a real thread', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { closeOutTask } = await import('$lib/server/completionClose');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		j.createJob({
			traceId: 'push-url-t1',
			worker: 'claude-code',
			category: 'code',
			brief: 'build something',
			fingerprint: 'fp1',
			predictedTokens: 0,
			threadId: 'thread-abc123'
		});
		j.markDispatched('push-url-t1');
		j.markDone('push-url-t1', 'all done');

		await closeOutTask('push-url-t1', 'done', 'all done');

		// Both web push and APNs should have been called with a threaded URL that
		// ALSO carries the trace_id (PR-0c deep-link → focus the task card).
		const allPayloads = [...webPushPayloads, ...apnsPayloads];
		expect(allPayloads.length).toBeGreaterThan(0);
		for (const p of allPayloads) {
			const payload = p as { url?: string };
			expect(payload.url).toContain('?thread=');
			expect(payload.url).toContain('thread-abc123');
			expect(payload.url).toContain('trace_id=');
			expect(payload.url).toContain('push-url-t1');
		}
	});

	it('completionClose: push URL contains ?thread=default when job has no thread_id', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { closeOutTask } = await import('$lib/server/completionClose');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		// Create a job with no threadId (defaults to '' / null → 'default' via resolveCompletionThread)
		j.createJob({
			traceId: 'push-url-t2',
			worker: 'claude-code',
			category: 'code',
			brief: 'background task',
			fingerprint: 'fp2',
			predictedTokens: 0
			// threadId omitted → resolveCompletionThread → 'default'
		});
		j.markDispatched('push-url-t2');
		j.markDone('push-url-t2', 'done');

		await closeOutTask('push-url-t2', 'done', 'done');

		const allPayloads = [...webPushPayloads, ...apnsPayloads];
		expect(allPayloads.length).toBeGreaterThan(0);
		for (const p of allPayloads) {
			const payload = p as { url?: string };
			expect(payload.url).toContain('?thread=');
			expect(payload.url).toContain('default');
		}
	});
});
