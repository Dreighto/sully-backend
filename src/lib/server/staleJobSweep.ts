// Clock-driven stale-job sweep (LOS-196 part 2). reapStaleJobs()'s criterion
// is proven correct (a single live activity GET reaped the LOS-196 case-study
// row instantly) — the gap was that reaping ONLY ran piggybacked on the
// /api/chat/activity GET, so with no client polling (the pill path reads the
// dispatch-stream endpoints; iOS backgrounding suspends client timers) a dead
// run stayed 'working' forever. The sweep now also runs on a server-side
// interval started from hooks.server.ts; the GET piggyback stays as
// belt-and-braces. Both callers share one throttle so concurrent sweeps can't
// double-post the stalled notice.
import { reapStaleJobs } from './dispatchJobs';
import { resolveCompletionThread } from './completionClose';
import { addChatMessage } from './chat';

let _lastReapMs = 0;

/**
 * Throttled sweep: reap stale in-flight jobs and post the stalled notice into
 * each job's thread. At most one sweep per 60s across ALL callers (interval +
 * GET piggyback). No reap-criterion change — reapStaleJobs() is untouched.
 */
export function sweepStaleJobs(): void {
	const now = Date.now();
	if (now - _lastReapMs < 60_000) return;
	_lastReapMs = now;
	try {
		for (const job of reapStaleJobs()) {
			const threadId = resolveCompletionThread(job.thread_id);
			addChatMessage(
				'local',
				`That task stalled — the worker never reported back. Want me to retry it?`,
				job.trace_id,
				null,
				null,
				'sent',
				threadId,
				{ taskId: job.trace_id }
			);
		}
	} catch (e) {
		console.warn('[stale-sweep] reap sweep skipped:', e);
	}
}

let _started = false;

/**
 * Start the server-side reaper interval (~60s) so reaping never depends on a
 * client being open. Idempotent; unref()'d so it can't block a clean shutdown
 * (same discipline as the completion poller's interval).
 */
export function startStaleJobReaper(intervalMs = 60_000): void {
	if (_started) return;
	_started = true;
	setInterval(sweepStaleJobs, intervalMs).unref();
}
