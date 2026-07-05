// WI-8 (voice seam timeouts): a wedged Jetson used to hang the mic forever —
// the voice /tts, Ollama /api/chat, and tool-loop fetches passed only the client
// (barge-in) signal with NO deadline, and the streaming read loop had no idle
// watchdog. Every OTHER voice seam bounds itself (dispatch 5s, STT 1.5s), so an
// unbounded Jetson call was an inconsistency, not house style.
//
// A fired timeout surfaces as a TimeoutError (name 'TimeoutError'), distinct
// from the client's AbortError — so callers route a wedge to HARD FAILURE while
// a genuine barge-in still routes to the clean truncate path (which stays keyed
// on the client signal, never on these deadlines).

/**
 * Compose the client barge-in signal with a fresh timeout deadline. When there
 * is no client signal, the timeout alone governs the request. If the timeout
 * fires the aborted reason is a TimeoutError; if the client aborts it is the
 * client's AbortError — the two stay distinguishable downstream.
 */
export function composeTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Idle-read watchdog: reject if a single `reader.read()` produces no chunk
 * within `ms`, so a stalled bridge fails fast instead of hanging the turn
 * forever. On timeout the reader is cancelled and a TimeoutError is thrown so
 * the caller routes it to hard failure (not the barge-in path).
 */
export async function readWithIdle<T>(
	reader: ReadableStreamDefaultReader<T>,
	ms: number
): Promise<ReadableStreamReadResult<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const readP = reader.read();
	// If the watchdog wins the race, the read promise settles later (rejected by
	// the cancel) — swallow it so it never surfaces as an unhandled rejection.
	readP.catch(() => {});
	const idle = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			void reader.cancel().catch(() => {});
			reject(new DOMException(`voice stream idle-read exceeded ${ms}ms`, 'TimeoutError'));
		}, ms);
	});
	try {
		return await Promise.race([readP, idle]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
