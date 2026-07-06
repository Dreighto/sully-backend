import { describe, it, expect } from 'vitest';
import { composeTimeout, readWithIdle } from '$lib/server/chat/voice_seam_timeout';

// WI-8: bound the Jetson voice seams so a wedged bridge can't hang the mic
// forever, while keeping a genuine barge-in (client abort) distinguishable from
// a timeout wedge so each routes correctly (barge-in = clean truncate, timeout =
// hard failure).

describe('WI-8 composeTimeout', () => {
	it('aborts with a TimeoutError (not AbortError) when the deadline fires', async () => {
		const signal = composeTimeout(undefined, 10);
		await new Promise((r) => setTimeout(r, 30));
		expect(signal.aborted).toBe(true);
		expect((signal.reason as Error).name).toBe('TimeoutError');
	});

	it('surfaces the client AbortError when the client aborts first', async () => {
		const ctrl = new AbortController();
		const signal = composeTimeout(ctrl.signal, 10_000);
		ctrl.abort();
		expect(signal.aborted).toBe(true);
		expect((signal.reason as Error).name).toBe('AbortError');
	});

	it('does not abort before either the client or the deadline', () => {
		const ctrl = new AbortController();
		const signal = composeTimeout(ctrl.signal, 10_000);
		expect(signal.aborted).toBe(false);
	});
});

describe('WI-8 readWithIdle', () => {
	it('rejects with a TimeoutError when no chunk arrives within the idle window', async () => {
		// A reader whose read() never settles — the wedged-bridge case.
		const reader = {
			read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
			cancel: () => Promise.resolve()
		} as unknown as ReadableStreamDefaultReader<Uint8Array>;
		await expect(readWithIdle(reader, 20)).rejects.toMatchObject({ name: 'TimeoutError' });
	});

	it('cancels the wedged reader when the watchdog fires', async () => {
		let cancelled = false;
		const reader = {
			read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
			cancel: () => {
				cancelled = true;
				return Promise.resolve();
			}
		} as unknown as ReadableStreamDefaultReader<Uint8Array>;
		await readWithIdle(reader, 20).catch(() => {});
		expect(cancelled).toBe(true);
	});

	it('returns the chunk when the read resolves before the deadline', async () => {
		const chunk = new Uint8Array([1, 2, 3]);
		const reader = {
			read: () => Promise.resolve({ value: chunk, done: false }),
			cancel: () => Promise.resolve()
		} as unknown as ReadableStreamDefaultReader<Uint8Array>;
		const res = await readWithIdle(reader, 10_000);
		expect(res.done).toBe(false);
		expect(res.value).toBe(chunk);
	});
});
