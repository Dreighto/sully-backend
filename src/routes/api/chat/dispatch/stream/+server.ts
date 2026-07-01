import type { RequestHandler } from './$types';
import { runMode, serverConfig } from '$lib/server/config';
import { sseEvent, parseLastEventId } from '$lib/server/sseFormat';
import { getJob } from '$lib/server/dispatchJobs';
import { HIDDEN_ACTIONS, isTerminalStatus } from '$lib/dispatchActivityView';
import fs from 'node:fs';
import Database from 'better-sqlite3';

// Pre-built placeholder list for the action deny-list (P2 leak fix): internal
// events (synthesis_completed, gate_evaluated, …) + terminal markers never
// stream to the card; everything else is a real worker step.
const HIDDEN_PLACEHOLDERS = HIDDEN_ACTIONS.map(() => '?').join(',');

const HEARTBEAT_MS = 15_000;
const POLL_MS = 1_000;

// The terminal gate mirrors the poll route (dispatch/[trace]/+server.ts): a job
// flips status→'done' then →'verified' ~45s BEFORE Sully writes the synthesized
// reply row, so those two are NON-terminal progress. Closing the stream there
// would drop an SSE-consuming card (Console/web) ~45s before the answer exists.
// Only a genuine sink terminates the stream: 'synthesized' (reply row written),
// 'failed', or 'aborted'. Safety cap: markVerified does not bump ended_at, so if
// closeOutTask stalls after markDone, 'done'/'verified' still terminate 90s after
// ended_at (measured from markDone) — the stream can't hang open forever. Same
// guard the poll route applies (which coerces to 'working' only while < 90s).
const SYNTH_SAFETY_CAP_MS = 90_000;

function shouldTerminate(status: string, endedAt: string | null | undefined): boolean {
	if (isTerminalStatus(status)) return true; // synthesized / failed / aborted
	if (status === 'done' || status === 'verified') {
		const ended = endedAt ? Date.parse(String(endedAt)) : 0;
		const sinceMs = ended ? Date.now() - ended : Number.POSITIVE_INFINITY;
		return sinceMs >= SYNTH_SAFETY_CAP_MS;
	}
	return false;
}

export const GET: RequestHandler = async ({ url, request }) => {
	if (!runMode.companionDispatchEnabled) {
		return new Response('dispatch disabled', { status: 404 });
	}
	const traceId = (url.searchParams.get('trace_id') || '').trim();
	if (!traceId) return new Response('trace_id required', { status: 400 });

	// Resume cursor: header wins, ?seq= fallback (some clients can't set it).
	let cursor = parseLastEventId(request.headers.get('last-event-id'));
	if (cursor === 0) cursor = parseLastEventId(`x:${url.searchParams.get('seq') || ''}`);

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				clearInterval(poll);
				clearInterval(beat);
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};

			const pump = () => {
				if (closed || !fs.existsSync(serverConfig.memoryDbPath)) return;
				const db = new Database(serverConfig.memoryDbPath, { readonly: true });
				try {
					const rows = db
						.prepare(
							`SELECT id, action, target FROM chat_activity
							 WHERE trace_id = ? AND id > ? AND action NOT IN (${HIDDEN_PLACEHOLDERS})
							 ORDER BY id ASC LIMIT 200`
						)
						.all(traceId, cursor, ...HIDDEN_ACTIONS) as {
						id: number;
						action: string;
						target: string | null;
					}[];
					for (const r of rows) {
						controller.enqueue(
							encoder.encode(sseEvent(traceId, r.id, { action: r.action, target: r.target }))
						);
						cursor = r.id;
					}
					const job = getJob(traceId);
					if (job && shouldTerminate(job.status, job.ended_at)) {
						controller.enqueue(
							encoder.encode(
								sseEvent(traceId, cursor + 1, {
									action: '__terminal__',
									status: job.status,
									result_ref: job.result_ref,
									// Timestamps let the card show a FROZEN duration that is identical
									// on live, reload, and scrollback — never a counting clock (P1).
									started_at: job.started_at,
									ended_at: job.ended_at
								})
							)
						);
						close();
					}
				} catch {
					/* table may not exist yet */
				} finally {
					db.close();
				}
			};

			const poll = setInterval(pump, POLL_MS);
			const beat = setInterval(() => {
				if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`));
			}, HEARTBEAT_MS);
			request.signal.addEventListener('abort', close);
			pump(); // immediate replay on connect
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive'
		}
	});
};
