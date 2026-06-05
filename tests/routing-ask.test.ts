import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

// ── isRoutingAnswer unit tests (no DB needed) ──────────────────────────────
import { isRoutingAnswer } from '$lib/server/routing/confirm';
describe('isRoutingAnswer', () => {
	it('defer answers', () => {
		for (const t of ['hold it', 'wait until that finishes', 'after this one', 'hold that', 'later'])
			expect(isRoutingAnswer(t)).toBe('defer');
	});
	it('sibling answers', () => {
		for (const t of [
			'run it separately',
			'start a separate one',
			'a new task',
			'do it now too',
			'separately'
		])
			expect(isRoutingAnswer(t)).toBe('sibling');
	});
	it('non-answers → null', () => {
		for (const t of ['what time is it', 'thanks', 'build a dashboard'])
			expect(isRoutingAnswer(t)).toBeNull();
	});
});

// ── proposal_type DB round-trip ────────────────────────────────────────────
const DB = '/tmp/sully-routing-ask-test.db';
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

describe('proposal_type round-trip', () => {
	it('routing_ask type is preserved via getPendingProposal', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		j.proposeTask({
			taskId: 'ra-1',
			threadId: 'tRA',
			source: 'chat',
			category: 'code',
			brief: 'x'
		});
		j.markClassified('ra-1', 'chat', null);
		j.markGatedProposal(
			'ra-1',
			{
				worker: 'claude-code',
				category: 'code',
				brief: 'fix the console build',
				targetRepo: 'companion',
				task: 'fix the console build'
			},
			'routing_ask'
		);
		const p = j.getPendingProposal('tRA');
		expect(p?.proposalType).toBe('routing_ask');
	});

	it('default proposal_type is "dispatch" (backward compat)', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		j.proposeTask({
			taskId: 'ra-2',
			threadId: 'tRB',
			source: 'chat',
			category: 'code',
			brief: 'x'
		});
		j.markClassified('ra-2', 'chat', null);
		// markGatedProposal WITHOUT a proposalType arg — defaults to 'dispatch'
		j.markGatedProposal('ra-2', {
			worker: 'claude-code',
			category: 'code',
			brief: 'do something',
			targetRepo: 'companion',
			task: 'do something'
		});
		const p = j.getPendingProposal('tRB');
		expect(p?.proposalType).toBe('dispatch');
	});

	it('getProposalByTaskId also exposes proposalType', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		j.proposeTask({
			taskId: 'ra-3',
			threadId: 'tRC',
			source: 'chat',
			category: 'code',
			brief: 'x'
		});
		j.markClassified('ra-3', 'chat', null);
		j.markGatedProposal(
			'ra-3',
			{
				worker: 'gemini',
				category: 'code',
				brief: 'audit logs',
				targetRepo: 'LogueOS-Console',
				task: 'audit logs'
			},
			'routing_ask'
		);
		const p = j.getProposalByTaskId('ra-3');
		expect(p?.proposalType).toBe('routing_ask');
	});

	it('rows missing proposal_type in JSON default to "dispatch"', async () => {
		const j = await import('$lib/server/dispatchJobs');
		const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
		bootstrapCompanionDb();
		// Write a legacy row by hand (no proposal_type in the JSON blob)
		j.proposeTask({
			taskId: 'ra-4',
			threadId: 'tRD',
			source: 'chat',
			category: 'code',
			brief: 'x'
		});
		j.markClassified('ra-4', 'chat', null);
		// Manually store a result_ref WITHOUT proposal_type (legacy format)
		const rawDb = new Database(DB);
		rawDb
			.prepare(
				"UPDATE pending_jobs SET status='gated', worker='claude-code', category='code', brief='old', result_ref=? WHERE trace_id='ra-4'"
			)
			.run(
				JSON.stringify({
					worker: 'claude-code',
					category: 'code',
					brief: 'old',
					targetRepo: 'companion',
					task: 'old task'
				})
			);
		rawDb.close();
		const p = j.getPendingProposal('tRD');
		expect(p?.proposalType).toBe('dispatch');
	});
});
