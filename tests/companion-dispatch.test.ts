import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-companion-dispatch-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	COMPANION_DISPATCH_ENABLED: 'true',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	COMPANION_DISPATCH_CAP: '20',
	COMPANION_DISPATCH_WINDOW_MIN: '1440',
	COMPANION_CALLBACK_SECRET: 'cbsecret',
	COMPANION_CALLBACK_BASE_URL: 'https://room.example.ts.net:8444/companion',
	LOGUEOS_DISPATCH_LISTENER_URL: 'http://127.0.0.1:19100',
	W4_LISTENER_HMAC_SECRET: 'listenersecret',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	vi.unstubAllGlobals();
});

describe('dispatchToWorker', () => {
	it('creates a decided job, signs the handoff with HMAC, and marks dispatched on 200', async () => {
		let captured: { url: string; body: string; sig: string } | null = null;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				captured = {
					url: String(url),
					body: String(init.body),
					sig: (init.headers as Record<string, string>)['X-W4-HMAC']
				};
				return new Response(JSON.stringify({ ok: true, trace_id: 'sully-1' }), { status: 200 });
			})
		);
		const { dispatchToWorker } = await import('$lib/server/companionDispatch');
		const j = await import('$lib/server/dispatchJobs');
		const res = await dispatchToWorker({
			traceId: 'sully-1',
			worker: 'claude-code',
			category: 'code',
			brief: 'fix the build',
			targetRepo: 'companion',
			task: 'fix the build',
			threadId: 'default'
		});
		expect(res.ok).toBe(true);
		expect(captured!.url).toContain('/dispatch');
		expect(captured!.sig).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
		expect(j.getJob('sully-1')?.status).toBe('dispatched');
	});

	it('refuses when the kill switch is engaged (gate level)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 200 }))
		);
		const brakes = await import('$lib/server/dispatchBrakes');
		brakes.engageKill();
		const { dispatchToWorker } = await import('$lib/server/companionDispatch');
		const res = await dispatchToWorker({
			traceId: 'sully-2',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			targetRepo: 'companion',
			task: 'x',
			threadId: 'default'
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/kill/i);
	});
});

describe('killAll', () => {
	it('aborts in-flight jobs and POSTs the listener /kill for each', async () => {
		const kills: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				if (String(url).endsWith('/kill')) kills.push(String(init.body));
				return new Response(JSON.stringify({ ok: true, killed_pid: 1, released_slot: null }), {
					status: 200
				});
			})
		);
		const j = await import('$lib/server/dispatchJobs');
		j.createJob({
			traceId: 'sully-9',
			worker: 'claude-code',
			category: 'code',
			brief: 'x',
			fingerprint: 'z',
			predictedTokens: 0
		});
		j.markDispatched('sully-9');
		j.markWorking('sully-9', 'editing');
		const { killAll } = await import('$lib/server/companionDispatch');
		await killAll();
		expect(j.getJob('sully-9')?.status).toBe('aborted');
		expect(kills.some((b) => b.includes('sully-9'))).toBe(true);
	});
});
