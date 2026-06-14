import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	decideSullyRoute,
	executeSullyModelCall,
	getSullySpendSnapshot,
	type SullyBackend,
	type SullyMode
} from '$lib/server/sully_model_router';

const envKeys = [
	'SULLY_ROUTER_DB_PATH',
	'SULLY_LOCAL_MODEL',
	'SULLY_CLAUDE_MODEL',
	'SULLY_GEMINI_MODEL',
	'SULLY_OLLAMA_CLOUD_MODEL',
	'SULLY_CLAUDE_MONTHLY_POOL_USD',
	'SULLY_CLAUDE_DAILY_PACE_USD',
	'SULLY_CLAUDE_CREDIT_USD_PER_1K_TOKENS',
	'SULLY_GEMINI_USD_PER_1K_TOKENS',
	'SULLY_OLLAMA_CLOUD_USD_PER_1K_TOKENS',
	'CONSOLE_OVERFLOW_SPEND_LIMIT_USD'
] as const;

let tmpDir = '';
let oldEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sully-router-test-'));
	oldEnv = {};
	for (const key of envKeys) oldEnv[key] = process.env[key];
	process.env.SULLY_ROUTER_DB_PATH = path.join(tmpDir, 'router.db');
	process.env.SULLY_LOCAL_MODEL = 'local-test';
	process.env.SULLY_CLAUDE_MODEL = 'claude-test';
	process.env.SULLY_GEMINI_MODEL = 'gemini-test';
	process.env.SULLY_OLLAMA_CLOUD_MODEL = 'ollama-cloud-test';
	process.env.SULLY_CLAUDE_MONTHLY_POOL_USD = '200';
	process.env.SULLY_CLAUDE_DAILY_PACE_USD = '6.66';
	process.env.SULLY_CLAUDE_CREDIT_USD_PER_1K_TOKENS = '10';
	process.env.SULLY_GEMINI_USD_PER_1K_TOKENS = '1';
	process.env.SULLY_OLLAMA_CLOUD_USD_PER_1K_TOKENS = '1';
	process.env.CONSOLE_OVERFLOW_SPEND_LIMIT_USD = '50';
});

afterEach(() => {
	for (const key of envKeys) {
		const value = oldEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeExecutors(
	overrides: Partial<Record<SullyBackend, 'down' | { tokens: number; reply?: string }>> = {}
) {
	const calls: Array<{ backend: SullyBackend; mode: SullyMode; model: string }> = [];
	const executor = (backend: SullyBackend) => async (args: { mode: SullyMode; model: string }) => {
		calls.push({ backend, mode: args.mode, model: args.model });
		const behavior = overrides[backend] ?? { tokens: 100, reply: backend };
		if (behavior === 'down') {
			const err = new Error(`${backend} down`);
			(err as Error & { status: number }).status = 503;
			throw err;
		}
		return {
			reply: behavior.reply ?? backend,
			usage: {
				input: Math.floor(behavior.tokens / 2),
				output: Math.ceil(behavior.tokens / 2),
				total: behavior.tokens
			}
		};
	};
	return {
		calls,
		executors: {
			local: executor('local'),
			claude: executor('claude'),
			gemini: executor('gemini'),
			ollama_cloud: executor('ollama_cloud')
		}
	};
}

describe('Sully model router', () => {
	it('routes on both axes and keeps sensitive context local by default', () => {
		const normal = decideSullyRoute({
			messages: [{ role: 'user', content: 'Investigate this multi-step task with tools.' }]
		});
		expect(normal.backend).toBe('local');
		expect(normal.mode).toBe('agentic_loop');

		const claude = decideSullyRoute({
			messages: [{ role: 'user', content: 'Use Claude for this agentic loop.' }]
		});
		expect(claude.backend).toBe('claude');
		expect(claude.mode).toBe('native_agentic');

		const privateTurn = decideSullyRoute({
			messages: [{ role: 'user', content: 'Use Gemini with this private password context.' }]
		});
		expect(privateTurn.backend).toBe('local');
		expect(privateTurn.sensitive).toBe(true);
	});

	it('caps Claude on rolling daily subscription credit and rolls unused monthly room forward', async () => {
		const first = fakeExecutors({ claude: { tokens: 10_000, reply: 'claude-first' } });
		const second = fakeExecutors({ local: { tokens: 100, reply: 'local-failover' } });
		const third = fakeExecutors({ claude: { tokens: 100, reply: 'claude-rolled' } });

		await executeSullyModelCall({
			tier: 'planning',
			messages: [{ role: 'user', content: 'Use Claude for planning.' }],
			executors: first.executors,
			now: new Date('2026-06-15T12:00:00.000Z'),
			traceId: 'trace-claude-fill'
		});

		const capped = await executeSullyModelCall({
			tier: 'planning',
			messages: [{ role: 'user', content: 'Use Claude for planning again.' }],
			executors: second.executors,
			now: new Date('2026-06-15T12:05:00.000Z'),
			traceId: 'trace-claude-capped'
		});
		expect(capped.provider_used).toBe('local');
		expect(capped.fell_forward).toBe(true);

		const rolled = await executeSullyModelCall({
			tier: 'planning',
			messages: [{ role: 'user', content: 'Use Claude for planning after rollover.' }],
			executors: third.executors,
			now: new Date('2026-06-16T12:00:00.000Z'),
			traceId: 'trace-claude-rolled'
		});
		expect(rolled.provider_used).toBe('claude');
		expect(rolled.mode_used).toBe('plain');
	});

	it('fails over when a selected backend is down and records routing corpus', async () => {
		const fakes = fakeExecutors({ gemini: 'down', local: { tokens: 88, reply: 'local-ok' } });
		const result = await executeSullyModelCall({
			tier: 'chat',
			messages: [{ role: 'user', content: 'Use Gemini for this answer.' }],
			executors: fakes.executors,
			now: new Date('2026-06-14T12:00:00.000Z'),
			traceId: 'trace-gemini-down',
			taskShape: ['router-smoke', 'backend-down']
		});

		expect(result.provider_used).toBe('local');
		expect(result.fell_forward).toBe(true);
		expect(fakes.calls.map((call) => call.backend)).toEqual(['gemini', 'local']);

		const db = new Database(process.env.SULLY_ROUTER_DB_PATH!);
		const row = db
			.prepare(
				'SELECT decision_json, alternatives_json, outcome_json FROM sully_routing_corpus WHERE trace_id = ?'
			)
			.get('trace-gemini-down') as {
			decision_json: string;
			alternatives_json: string;
			outcome_json: string;
		};
		db.close();
		expect(JSON.parse(row.decision_json).backend).toBe('gemini');
		expect(
			JSON.parse(row.alternatives_json).some((alt: { backend: string }) => alt.backend === 'local')
		).toBe(true);
		expect(JSON.parse(row.outcome_json).backend).toBe('local');
	});

	it('reports per-backend spend across metered and Claude subscription tracks', async () => {
		const fakes = fakeExecutors({
			gemini: { tokens: 1000, reply: 'gemini-ok' },
			ollama_cloud: { tokens: 2000, reply: 'ollama-cloud-ok' },
			claude: { tokens: 500, reply: 'claude-ok' },
			local: { tokens: 300, reply: 'local-ok' }
		});

		for (const text of [
			'Use Gemini for this answer.',
			'Use Ollama Cloud for this answer.',
			'Use Claude for this answer.',
			'Use local qwen for this answer.'
		]) {
			await executeSullyModelCall({
				tier: 'chat',
				messages: [{ role: 'user', content: text }],
				executors: fakes.executors,
				now: new Date('2026-06-14T12:00:00.000Z')
			});
		}

		const spend = getSullySpendSnapshot(new Date('2026-06-14T12:10:00.000Z'));
		const byBackend = new Map(spend.backends.map((entry) => [entry.backend, entry]));

		expect(byBackend.get('local')?.track).toBe('free_local');
		expect(byBackend.get('claude')?.track).toBe('claude_subscription');
		expect(byBackend.get('gemini')?.track).toBe('metered');
		expect(byBackend.get('ollama_cloud')?.track).toBe('metered');
		expect(spend.claude_subscription.rolling_available_usd).toBeCloseTo(93.24);
		expect(spend.claude_subscription.spent_usd).toBeGreaterThan(0);
		expect(spend.metered_overflow.spent_usd).toBeGreaterThan(0);
	});
});
