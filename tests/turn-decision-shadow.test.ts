// D1.2: Tests for the pre-stream shadow decision in prepareTurnLifecycle.
// Verifies that:
//   1. shadowDecision.kind is correct for brainstorm, work-intent, and @cc turns.
//   2. A `turn_decision_shadow` journal row is written with the correct kind.
//   3. The live reply/dispatch path is unaffected (existing behavior tests stay green).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-turn-decision-shadow-test.db';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: DB,
		COMPANION_DISPATCH_ENABLED: 'true'
	}
}));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

/** Read all chat_activity rows for a task. */
function getActivityRows(taskId: string): { action: string; target: string | null }[] {
	if (!fs.existsSync(DB)) return [];
	const db = new Database(DB);
	try {
		return db
			.prepare('SELECT action, target FROM chat_activity WHERE trace_id = ?')
			.all(taskId) as { action: string; target: string | null }[];
	} finally {
		db.close();
	}
}

describe('D1.2 — prepareTurnLifecycle shadow decision', () => {
	it('brainstorm turn → shadowDecision.kind === ANSWER_NOW + journal row exists', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const { prepareTurnLifecycle } = await import('$lib/server/chat/stream_prepare');

		const result = await prepareTurnLifecycle({
			text: 'just kicking an idea around, no action needed',
			threadId: 'tShadow1',
			sender: 'operator',
			source: 'chat'
		});

		expect(result.shadowDecision.kind).toBe('ANSWER_NOW');

		const rows = getActivityRows(result.taskId);
		const shadowRow = rows.find((r) => r.action === 'turn_decision_shadow');
		expect(shadowRow, 'turn_decision_shadow journal row must exist').toBeTruthy();
		expect(JSON.parse(shadowRow!.target ?? '{}')).toMatchObject({ kind: 'ANSWER_NOW' });
	});

	it('work-intent turn → shadowDecision.kind === PROPOSE + journal row exists', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const { prepareTurnLifecycle } = await import('$lib/server/chat/stream_prepare');

		const result = await prepareTurnLifecycle({
			text: 'audit the console repo and fix the build',
			threadId: 'tShadow2',
			sender: 'operator',
			source: 'chat'
		});

		expect(result.shadowDecision.kind).toBe('PROPOSE');

		const rows = getActivityRows(result.taskId);
		const shadowRow = rows.find((r) => r.action === 'turn_decision_shadow');
		expect(shadowRow, 'turn_decision_shadow journal row must exist').toBeTruthy();
		expect(JSON.parse(shadowRow!.target ?? '{}')).toMatchObject({ kind: 'PROPOSE' });
	});

	it('@cc turn → shadowDecision.kind === DISPATCH + journal row exists', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const { prepareTurnLifecycle } = await import('$lib/server/chat/stream_prepare');

		const result = await prepareTurnLifecycle({
			text: '@cc fix the failing build in the auth endpoint',
			threadId: 'tShadow3',
			sender: 'operator',
			source: 'chat'
		});

		expect(result.shadowDecision.kind).toBe('DISPATCH');
		if (result.shadowDecision.kind === 'DISPATCH') {
			expect(result.shadowDecision.worker).toBe('claude-code');
		}

		const rows = getActivityRows(result.taskId);
		const shadowRow = rows.find((r) => r.action === 'turn_decision_shadow');
		expect(shadowRow, 'turn_decision_shadow journal row must exist').toBeTruthy();
		expect(JSON.parse(shadowRow!.target ?? '{}')).toMatchObject({ kind: 'DISPATCH' });
	});

	it('shadowDecision is present on PreparedStreamContext via prepareStream', async () => {
		// Verify the field is threaded all the way to prepareStream's return value.
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const { prepareStream } = await import('$lib/server/chat/stream_prepare');

		const fakeHeaders = new Headers();
		const result = await prepareStream({
			messages: [
				{
					id: 'msg1',
					role: 'user',
					parts: [{ type: 'text', text: 'just thinking out loud' }]
				}
			],
			threadId: 'tShadow4',
			userText: 'just thinking out loud',
			headers: fakeHeaders
		});

		expect(result.shadowDecision).toBeDefined();
		expect(typeof result.shadowDecision.kind).toBe('string');
	});

	it('shadow does NOT alter the mutationGate result or the taskId', async () => {
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		const { prepareTurnLifecycle } = await import('$lib/server/chat/stream_prepare');

		const result = await prepareTurnLifecycle({
			text: 'thanks, that all makes sense',
			threadId: 'tShadow5',
			sender: 'operator',
			source: 'chat'
		});

		// taskId is still present (not mutated by shadow)
		expect(result.taskId).toMatch(/^sully-/);
		// mutationGate still present
		expect(result.mutationGate.classification).toBeDefined();
		// shadowDecision is a separate field
		expect(result.shadowDecision).toBeDefined();
	});
});
