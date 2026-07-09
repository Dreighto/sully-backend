import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	type FinishReason,
	type UIMessageChunk
} from 'ai';
import { deleteChatMessage } from '$lib/server/chat';
import { expireTaskById } from '$lib/server/dispatchJobs';

export type SullyRoutingFrame = {
	handled_by: 'sdk' | 'cli';
	model: string;
	provider?: string;
	tier?: string;
	reason?: string;
	fell_forward?: boolean;
	source?: 'auto' | 'picker' | 'voice';
};

export type RoutingWriter = {
	write: (chunk: { type: 'data-sully-routing'; data: SullyRoutingFrame }) => void;
};

export function emitRoutingFrame(writer: RoutingWriter, data: SullyRoutingFrame): void {
	try {
		writer.write({ type: 'data-sully-routing', data });
	} catch {
		/* stream already closed */
	}
}

export type ReplyIdWriter = {
	write: (
		chunk:
			| { type: 'data-sully-reply-id'; data: { id: number } }
			| { type: 'finish'; finishReason: FinishReason | undefined }
	) => void;
};

export function emitReplyId(writer: ReplyIdWriter, replyId: number | undefined): void {
	if (typeof replyId === 'number' && replyId > 0) {
		writer.write({ type: 'data-sully-reply-id', data: { id: replyId } });
	}
}

export function finishWriter(writer: ReplyIdWriter, finishReason: FinishReason | undefined): void {
	writer.write({ type: 'finish', finishReason });
}

export function finishWithReplyId(
	writer: ReplyIdWriter,
	replyId: number | undefined,
	finishReason: FinishReason | undefined
): void {
	emitReplyId(writer, replyId);
	finishWriter(writer, finishReason);
}

// ---------------------------------------------------------------------------
// Resumable streams (AI SDK v6 pattern, single-user in-memory variant).
// While an sdk-stream turn generates, its UIMessage chunks are buffered in a
// per-thread ring buffer so a client that dropped the POST response can
// reattach via GET /api/chat/sdk-stream/resume?thread=X&startIndex=N.
// The buffer is cleared on finish/error/rollback; resume then returns 204.

type StreamListener = {
	onChunk: (chunk: UIMessageChunk) => void;
	onDone: () => void;
};

type ActiveStream = {
	chunks: UIMessageChunk[];
	baseIndex: number; // global index of chunks[0] (ring buffer may have dropped earlier chunks)
	listeners: Set<StreamListener>;
	onSupersede?: () => void;
};

const MAX_BUFFERED_CHUNKS = 4096;
const activeStreams = new Map<string, ActiveStream>();

function closeListeners(stream: ActiveStream): void {
	for (const listener of Array.from(stream.listeners)) {
		try {
			listener.onDone();
		} catch {
			/* client already disconnected */
		}
	}
	stream.listeners.clear();
}

export type ActiveStreamHandle = {
	record: (chunk: UIMessageChunk) => void;
	end: () => void;
	isCurrent: () => boolean;
};

type BeginActiveStreamOptions = {
	onSupersede?: () => void;
};

/** Registers a new active stream for the thread and returns a handle bound to
 * it. If a newer turn supersedes this one, the stale handle's record/end
 * become no-ops instead of corrupting the newer buffer. */
export function beginActiveStream(
	threadId: string,
	options: BeginActiveStreamOptions = {}
): ActiveStreamHandle {
	const previous = activeStreams.get(threadId);
	try {
		previous?.onSupersede?.();
	} finally {
		if (previous) closeListeners(previous);
	}
	const stream: ActiveStream = {
		chunks: [],
		baseIndex: 0,
		listeners: new Set(),
		onSupersede: options.onSupersede
	};
	activeStreams.set(threadId, stream);

	// --- Delta coalescing (2026-07-09 perf audit) ---------------------------
	// Providers emit near-per-token deltas; forwarding each as its own SSE
	// frame made a long reply hundreds-to-thousands of tiny frames, each a
	// parse + state mutation on the iOS main thread (measured as general UI
	// "spottiness"). Consecutive text-/reasoning-deltas for the same block are
	// merged and flushed on a short window instead — the AI SDK 7 pattern. The
	// FIRST text-delta still flushes immediately so time-to-first-token is
	// unchanged, and any non-delta chunk flushes pending deltas before
	// committing so ordering is exact. Coalescing happens BEFORE the ring
	// buffer, so resume replays get the merged frames too.
	const COALESCE_MS = 60;
	let pending: { type: 'text-delta' | 'reasoning-delta'; id: string; delta: string } | null = null;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let sentFirstTextDelta = false;

	function commit(chunk: UIMessageChunk): void {
		stream.chunks.push(chunk);
		const overflow = stream.chunks.length - MAX_BUFFERED_CHUNKS;
		if (overflow > 0) {
			stream.chunks.splice(0, overflow);
			stream.baseIndex += overflow;
		}
		for (const listener of Array.from(stream.listeners)) {
			try {
				listener.onChunk(chunk);
			} catch {
				stream.listeners.delete(listener);
			}
		}
	}

	function flushPending(): void {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		if (!pending) return;
		const merged = pending;
		pending = null;
		commit({ type: merged.type, id: merged.id, delta: merged.delta } as UIMessageChunk);
	}

	return {
		record(chunk) {
			if (activeStreams.get(threadId) !== stream) return;
			const c = chunk as { type?: string; id?: string; delta?: string };
			const isDelta =
				(c.type === 'text-delta' || c.type === 'reasoning-delta') &&
				typeof c.id === 'string' &&
				typeof c.delta === 'string';
			if (!isDelta) {
				flushPending();
				commit(chunk);
				return;
			}
			if (c.type === 'text-delta' && !sentFirstTextDelta) {
				sentFirstTextDelta = true;
				flushPending();
				commit(chunk);
				return;
			}
			if (pending && pending.type === c.type && pending.id === c.id) {
				pending.delta += c.delta as string;
			} else {
				flushPending();
				pending = {
					type: c.type as 'text-delta' | 'reasoning-delta',
					id: c.id as string,
					delta: c.delta as string
				};
			}
			if (!flushTimer) flushTimer = setTimeout(flushPending, COALESCE_MS);
		},
		end() {
			if (activeStreams.get(threadId) !== stream) return;
			flushPending();
			activeStreams.delete(threadId);
			closeListeners(stream);
		},
		isCurrent() {
			return activeStreams.get(threadId) === stream;
		}
	};
}

export function hasActiveStream(threadId: string): boolean {
	return activeStreams.has(threadId);
}

/** Synchronously replays buffered chunks from startIndex, then registers the
 * listener for live chunks. Returns an unsubscribe fn, or null when no stream
 * is active for the thread. */
export function subscribeToActiveStream(
	threadId: string,
	startIndex: number,
	listener: StreamListener
): (() => void) | null {
	const stream = activeStreams.get(threadId);
	if (!stream) return null;
	const flooredStart = Math.floor(startIndex);
	// WI-10b: on a >MAX_BUFFERED_CHUNKS turn the ring buffer drops its OLDEST
	// chunks (baseIndex advances). A resumer whose startIndex predates baseIndex
	// never saw those dropped chunks — replaying from baseIndex would silently
	// stitch a HOLE into the reply. Signal the gap so the client discards its
	// partial streamed row and force-reconciles the final text from history
	// instead of trusting the holed stream. (The client MUST NOT retag the holed
	// row to hist-<id>, or history dedup skips the good persisted row.)
	if (flooredStart < stream.baseIndex) {
		try {
			listener.onChunk({
				type: 'data-sully-gap',
				data: {
					resumedAtIndex: stream.baseIndex,
					requestedFrom: flooredStart,
					droppedChunks: stream.baseIndex - flooredStart
				}
			} as unknown as UIMessageChunk);
		} catch {
			return () => {};
		}
	}
	const from = Math.max(flooredStart, stream.baseIndex);
	for (let i = from - stream.baseIndex; i < stream.chunks.length; i++) {
		const chunk = stream.chunks[i];
		if (!chunk) continue;
		try {
			listener.onChunk(chunk);
		} catch {
			return () => {};
		}
	}
	stream.listeners.add(listener);
	return () => stream.listeners.delete(listener);
}

/** SSE UIMessage-stream Response fed from the per-thread buffer: replays from
 * startIndex, then continues live until the turn ends. The generating turn is
 * pumped independently, so a dropped consumer never stalls generation. */
export function streamResponseFromBuffer(threadId: string, startIndex: number): Response {
	const stream = createUIMessageStream({
		execute: ({ writer }) =>
			new Promise<void>((resolve) => {
				const unsubscribe = subscribeToActiveStream(threadId, startIndex, {
					onChunk: (chunk) => writer.write(chunk),
					onDone: () => resolve()
				});
				if (!unsubscribe) resolve();
			})
	});
	return createUIMessageStreamResponse({ stream });
}

// Orphan rollback (Stage 1). prepareTurnLifecycle persists the operator row +
// mints a 'proposed' Task BEFORE the model runs. When a turn terminates having
// emitted ZERO reply tokens AND written NO assistant row, undo both, scoped to
// this exact turn. Reused turns are never rollback-eligible because the row/task
// pre-existed this request.
export function rollbackOrphanTurn(operatorRowId: number, taskId: string, reused: boolean): void {
	if (reused) return;
	try {
		if (operatorRowId) deleteChatMessage(operatorRowId);
		expireTaskById(taskId);
	} catch (e) {
		console.error('[sdk-stream] orphan rollback failed', e);
	}
}
