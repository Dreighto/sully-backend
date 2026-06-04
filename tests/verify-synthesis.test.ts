import { describe, it, expect, vi } from 'vitest';
const calls: { question: string; system?: string }[] = [];
vi.mock('$lib/server/chat/consult', () => ({
	runConsultClaude: vi.fn(async (q: string, _m: string, system?: string) => {
		calls.push({ question: q, system });
		return { answer: 'ok' };
	})
}));

describe('synthesizeWorkerResult posture framing', () => {
	it('hedge posture instructs the model NOT to state unverified claims as fact', async () => {
		const { synthesizeWorkerResult } = await import('$lib/server/routing/synthesize');
		await synthesizeWorkerResult({ brief: 'b', result: 'r', posture: 'hedge' });
		expect((calls.at(-1)!.system || '').toLowerCase()).toMatch(
			/could ?n.t (independently )?confirm|hedge|not.*as fact/
		);
	});
	it('warn posture instructs a heads-up framing', async () => {
		const { synthesizeWorkerResult } = await import('$lib/server/routing/synthesize');
		await synthesizeWorkerResult({ brief: 'b', result: 'r', posture: 'warn' });
		expect((calls.at(-1)!.system || '').toLowerCase()).toMatch(
			/heads-up|doesn.t line up|contradict/
		);
	});
});
