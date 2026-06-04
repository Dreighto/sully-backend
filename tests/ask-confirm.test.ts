import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-ask-confirm-test.db';
const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: DB,
	COMPANION_DISPATCH_ENABLED: 'true'
};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));
// dispatchToWorker hits the listener over HMAC — mock it. Default: success.
const dispatchMock = vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string });
vi.mock('$lib/server/companionDispatch', () => ({ dispatchToWorker: dispatchMock }));

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
	dispatchMock.mockClear();
	dispatchMock.mockResolvedValue({ ok: true });
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

/** Seed a 'gated' proposal + its pending_approval Ask message, as the Ask path does. */
async function seedProposal(taskId: string, threadId: string) {
	const j = await import('$lib/server/dispatchJobs');
	const { addChatMessage } = await import('$lib/server/chat');
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	bootstrapCompanionDb();
	j.proposeTask({ taskId, threadId, source: 'chat', category: 'code', brief: 'fix the build' });
	j.markClassified(taskId, 'chat', null);
	j.markGatedProposal(taskId, {
		worker: 'claude-code',
		category: 'code',
		brief: 'fix the build',
		targetRepo: 'companion',
		task: 'fix the build please'
	});
	addChatMessage(
		'local',
		'That looks like a job for CC — "fix the build". Want me to run it?',
		taskId,
		null,
		null,
		'pending_approval',
		threadId,
		{ taskId }
	);
}

function post(taskId: string, decision: string) {
	return new Request('http://localhost/companion/api/chat/dispatch/confirm', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ taskId, decision })
	});
}

describe('getProposalByTaskId', () => {
	it('returns a gated proposal by task id, and null once it is no longer gated', async () => {
		await seedProposal('sully-p1', 't1');
		const j = await import('$lib/server/dispatchJobs');
		const p = j.getProposalByTaskId('sully-p1');
		expect(p?.worker).toBe('claude-code');
		expect(p?.brief).toBe('fix the build');
		j.markAborted('sully-p1'); // gated → aborted
		expect(j.getProposalByTaskId('sully-p1')).toBeNull(); // safe against post-expiry tap
	});
});

describe('confirm endpoint — dismiss', () => {
	it('aborts the proposal, clears the buttons, posts a hold-off note, never dispatches', async () => {
		await seedProposal('sully-d1', 'tD');
		const { POST } = await import('../src/routes/api/chat/dispatch/confirm/+server');
		const res = await POST({ request: post('sully-d1', 'dismiss') } as never);
		const bodyJson = await res.json();
		expect(bodyJson).toMatchObject({ ok: true, dispatched: false });
		expect(dispatchMock).not.toHaveBeenCalled();

		const j = await import('$lib/server/dispatchJobs');
		expect(j.getProposalByTaskId('sully-d1')).toBeNull(); // aborted
		const { getChatMessages } = await import('$lib/server/chat');
		const msgs = getChatMessages(50, 'tD');
		// the Ask bubble's buttons are cleared (status no longer pending_approval)
		expect(msgs.find((m) => m.trace_id === 'sully-d1')?.status).not.toBe('pending_approval');
		expect(msgs.some((m) => m.message.includes('hold off'))).toBe(true);
	});
});

describe('confirm endpoint — run', () => {
	it('dispatches, flips the bubble to approved, and posts the on-it message', async () => {
		await seedProposal('sully-r1', 'tR');
		const { POST } = await import('../src/routes/api/chat/dispatch/confirm/+server');
		const res = await POST({ request: post('sully-r1', 'run') } as never);
		const bodyJson = await res.json();
		expect(bodyJson).toMatchObject({ ok: true, dispatched: true });
		expect(dispatchMock).toHaveBeenCalledTimes(1);

		const { getChatMessages } = await import('$lib/server/chat');
		const msgs = getChatMessages(50, 'tR');
		expect(msgs.find((m) => m.trace_id === 'sully-r1')?.status).toBe('approved');
		expect(msgs.some((m) => m.message.includes('handing that to CC'))).toBe(true);
	});

	it('is safe on a double-tap / expired proposal: no second dispatch, buttons cleared', async () => {
		await seedProposal('sully-r2', 'tR2');
		const j = await import('$lib/server/dispatchJobs');
		j.markAborted('sully-r2'); // simulate already-expired (operator moved on)
		const { POST } = await import('../src/routes/api/chat/dispatch/confirm/+server');
		const res = await POST({ request: post('sully-r2', 'run') } as never);
		const bodyJson = await res.json();
		expect(bodyJson).toMatchObject({ ok: true, expired: true });
		expect(dispatchMock).not.toHaveBeenCalled();
		const { getChatMessages } = await import('$lib/server/chat');
		const msgs = getChatMessages(50, 'tR2');
		expect(msgs.find((m) => m.trace_id === 'sully-r2')?.status).not.toBe('pending_approval');
	});
});

describe('confirm endpoint — guards', () => {
	it('rejects a public-Funnel caller', async () => {
		await seedProposal('sully-g1', 'tG');
		const { POST } = await import('../src/routes/api/chat/dispatch/confirm/+server');
		const req = new Request('http://localhost/companion/api/chat/dispatch/confirm', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'tailscale-funnel-request': '1' },
			body: JSON.stringify({ taskId: 'sully-g1', decision: 'run' })
		});
		const res = await POST({ request: req } as never);
		expect(res.status).toBe(401);
		expect(dispatchMock).not.toHaveBeenCalled();
	});
	it('rejects a bad decision value', async () => {
		const { POST } = await import('../src/routes/api/chat/dispatch/confirm/+server');
		const res = await POST({ request: post('sully-x', 'maybe') } as never);
		expect(res.status).toBe(400);
	});
});
