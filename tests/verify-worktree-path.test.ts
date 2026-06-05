// 5a refinement: the artifact channel must accept a worker's artifact when it
// lives under the worktrees tree (~/dev/worktrees/<repo>/wN) — workers build in
// worktrees, not the repo's main checkout. The git channel still binds the commit
// to the specific repo. Uses LOGUEOS_WORKTREES_BASE override for isolation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const job = () => ({ trace_id: 'w', status: 'done', started_at: '2000-01-01 00:00:00' }) as never;

let base = '';
beforeEach(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-base-'));
	process.env.LOGUEOS_WORKTREES_BASE = base;
	vi.resetModules();
});
afterEach(() => {
	delete process.env.LOGUEOS_WORKTREES_BASE;
	fs.rmSync(base, { recursive: true, force: true });
});

describe('artifact channel — worktree paths (5a refinement)', () => {
	it('GO when the artifact lives under the worktrees base (worker worktree) for a known repo', async () => {
		const p = path.join(base, 'sully-workspace', 'w1', 'demo', 'index.html');
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, '<html><button>hi</button></html>');
		const { runPoll } = await import('$lib/server/verifyPoll');
		const r = await runPoll(job(), { fs_paths: [p], repo: 'sully-workspace' });
		expect(r.channels.find((c) => c.channel === 'artifact')!.state).toBe('GO');
	});
	it('NO_GO when the artifact is outside BOTH the repo root and the worktrees base', async () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
		const p = path.join(outside, 'x.txt');
		fs.writeFileSync(p, 'x');
		const { runPoll } = await import('$lib/server/verifyPoll');
		const r = await runPoll(job(), { fs_paths: [p], repo: 'sully-workspace' });
		expect(r.channels.find((c) => c.channel === 'artifact')!.state).toBe('NO_GO');
		fs.rmSync(outside, { recursive: true, force: true });
	});
});
