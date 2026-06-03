import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/chat/consult', () => ({ runConsultClaude: vi.fn() }));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});

describe('synthesizeWorkerResult', () => {
	it('returns the Haiku plain-English summary on success (called with haiku + a plain-English system prompt)', async () => {
		const { runConsultClaude } = await import('$lib/server/chat/consult');
		(runConsultClaude as ReturnType<typeof vi.fn>).mockResolvedValue({
			answer: 'I had CC check the build — all green, nothing to worry about.',
			model: 'claude-haiku-4-5-20251001',
			note: 'x'
		});
		const { synthesizeWorkerResult } = await import('$lib/server/routing/synthesize');
		const out = await synthesizeWorkerResult({
			brief: 'fix the build',
			result: 'BUILD SUCCESS, 0 errors'
		});
		expect(out).toMatch(/all green/);
		const call = (runConsultClaude as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1]).toBe('claude-haiku-4-5-20251001');
		expect(String(call[2])).toMatch(/plain English/i);
	});

	it('returns null when the model errors (caller falls back to raw)', async () => {
		const { runConsultClaude } = await import('$lib/server/chat/consult');
		(runConsultClaude as ReturnType<typeof vi.fn>).mockResolvedValue({ error: 'HTTP 500' });
		const { synthesizeWorkerResult } = await import('$lib/server/routing/synthesize');
		expect(await synthesizeWorkerResult({ brief: 'x', result: 'something happened' })).toBeNull();
	});

	it('returns null (no model call) for an empty worker result', async () => {
		const { runConsultClaude } = await import('$lib/server/chat/consult');
		const { synthesizeWorkerResult } = await import('$lib/server/routing/synthesize');
		expect(await synthesizeWorkerResult({ brief: 'x', result: '   ' })).toBeNull();
		expect(runConsultClaude as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});
});
