// Delta coalescing on the active-stream buffer (2026-07-09 perf fix).
// Providers emit near-per-token deltas; forwarding each as its own SSE frame
// flooded the iOS client (a parse + main-thread state mutation per frame).
// Contract: first text-delta passes through immediately (TTFT unchanged);
// subsequent same-block deltas merge and flush on the 60ms window, on any
// non-delta chunk, or on end(); ordering is exact.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import {
	beginActiveStream,
	subscribeToActiveStream
} from '../src/lib/server/chat/sdk_stream_common';

type AnyChunk = { type: string; id?: string; delta?: string };

function collect(threadId: string): AnyChunk[] {
	const seen: AnyChunk[] = [];
	subscribeToActiveStream(threadId, 0, {
		onChunk: (chunk: UIMessageChunk) => seen.push(chunk as unknown as AnyChunk),
		onDone: () => {}
	});
	return seen;
}

describe('active-stream delta coalescing', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('passes the first text-delta through immediately (TTFT)', () => {
		const handle = beginActiveStream('t-coalesce-ttft');
		const seen = collect('t-coalesce-ttft');
		handle.record({ type: 'text-delta', id: '0', delta: 'Hel' } as UIMessageChunk);
		expect(seen).toEqual([{ type: 'text-delta', id: '0', delta: 'Hel' }]);
		handle.end();
	});

	it('merges subsequent same-block deltas and flushes on the window', () => {
		const handle = beginActiveStream('t-coalesce-merge');
		const seen = collect('t-coalesce-merge');
		handle.record({ type: 'text-delta', id: '0', delta: 'a' } as UIMessageChunk); // immediate
		handle.record({ type: 'text-delta', id: '0', delta: 'b' } as UIMessageChunk);
		handle.record({ type: 'text-delta', id: '0', delta: 'c' } as UIMessageChunk);
		handle.record({ type: 'text-delta', id: '0', delta: 'd' } as UIMessageChunk);
		expect(seen).toHaveLength(1); // b/c/d pending
		vi.advanceTimersByTime(60);
		expect(seen).toEqual([
			{ type: 'text-delta', id: '0', delta: 'a' },
			{ type: 'text-delta', id: '0', delta: 'bcd' }
		]);
		handle.end();
	});

	it('flushes pending deltas before any non-delta chunk (ordering exact)', () => {
		const handle = beginActiveStream('t-coalesce-order');
		const seen = collect('t-coalesce-order');
		handle.record({ type: 'text-delta', id: '0', delta: 'a' } as UIMessageChunk);
		handle.record({ type: 'text-delta', id: '0', delta: 'b' } as UIMessageChunk);
		handle.record({ type: 'text-end', id: '0' } as UIMessageChunk);
		expect(seen.map((c) => c.type)).toEqual(['text-delta', 'text-delta', 'text-end']);
		expect(seen[1]).toEqual({ type: 'text-delta', id: '0', delta: 'b' });
		handle.end();
	});

	it('end() flushes any pending delta so no text is lost', () => {
		const handle = beginActiveStream('t-coalesce-end');
		const seen = collect('t-coalesce-end');
		handle.record({ type: 'text-delta', id: '0', delta: 'a' } as UIMessageChunk);
		handle.record({ type: 'text-delta', id: '0', delta: 'tail' } as UIMessageChunk);
		handle.end();
		expect(seen[seen.length - 1]).toEqual({ type: 'text-delta', id: '0', delta: 'tail' });
	});

	it('reasoning deltas coalesce independently of text deltas', () => {
		const handle = beginActiveStream('t-coalesce-reason');
		const seen = collect('t-coalesce-reason');
		handle.record({ type: 'reasoning-delta', id: 'r', delta: 'think' } as UIMessageChunk);
		handle.record({ type: 'reasoning-delta', id: 'r', delta: 'ing' } as UIMessageChunk);
		vi.advanceTimersByTime(60);
		expect(seen).toEqual([{ type: 'reasoning-delta', id: 'r', delta: 'thinking' }]);
		handle.end();
	});
});
