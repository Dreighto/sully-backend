import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPoll, type EvidenceEnvelope } from '$lib/server/verifyPoll';

const job = (over: Record<string, unknown> = {}) =>
	({
		trace_id: 's1',
		status: 'done',
		started_at: '2000-01-01 00:00:00',
		...over
	}) as never;

describe('runPoll channels', () => {
	it('done job, no pointers → FSM channels GO (liveness) but posture HEDGE, never confirmed', async () => {
		const r = await runPoll(job(), {});
		const wc = r.channels.find((c) => c.channel === 'worker_completion')!;
		const ts = r.channels.find((c) => c.channel === 'task_state')!;
		expect(wc.state).toBe('GO');
		expect(ts.state).toBe('GO');
		expect(r.channels.find((c) => c.channel === 'git')!.state).toBe('SKIPPED');
		// liveness-only → cannot confirm a deliverable that wasn't checked
		expect(r.posture).toBe('hedge');
	});
	it('a real deliverable GO (an existing artifact) → confirmed', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-'));
		const p = path.join(dir, 'made.txt');
		fs.writeFileSync(p, 'x');
		const r = await runPoll(job(), { fs_paths: [p] });
		expect(r.posture).toBe('confirmed');
	});
	it('failed job → worker_completion NO_GO (critical) → needs_review + warn', async () => {
		const r = await runPoll(job({ status: 'failed' }), {});
		expect(r.channels.find((c) => c.channel === 'worker_completion')!.state).toBe('NO_GO');
		expect(r.posture).toBe('warn');
		expect(r.needs_review).toBe(true);
	});
	it('artifact GO when a declared path exists with post-start mtime', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-'));
		const p = path.join(dir, 'made.txt');
		fs.writeFileSync(p, 'x');
		const env: EvidenceEnvelope = { fs_paths: [p] };
		const r = await runPoll(job(), env);
		expect(r.channels.find((c) => c.channel === 'artifact')!.state).toBe('GO');
	});
	it('artifact NO_GO when a declared path does not exist', async () => {
		const r = await runPoll(job(), { fs_paths: ['/tmp/does-not-exist-xyz.123'] });
		expect(r.channels.find((c) => c.channel === 'artifact')!.state).toBe('NO_GO');
		expect(r.needs_review).toBe(true); // artifact is critical
	});
});
