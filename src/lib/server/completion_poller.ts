// Background poller that tails cc_completion_log.jsonl. Two consumers share
// the tail:
//   1. Web Push notify when a worker dispatched FROM CHAT (entry has
//      thread_id) completes — the original wired-mode consumer.
//   2. Terminal bridge (LOS-196): kernel terminal markers for in-flight
//      companion dispatch jobs (sully-*/rtr-*) are mapped onto markDone/
//      markFailed + closeOutTask, so a worker that dies without POSTing its
//      own terminal callback still reconciles pending_jobs and the client
//      never keeps rendering a dead run as live.
//
// Started once at server boot via hooks.server.ts. Polls every 30 seconds.
// Only reads bytes appended since the last poll — no replay of history on boot.

import fs from 'node:fs';
import { serverConfig, runMode, appIdentity } from './config';
import { sendPushToAll } from './web_push';
import { incrementBadge } from './push_badge';
import { getJob, markDone, markFailed, RUNNING_STATES } from './dispatchJobs';
import { closeOutTask } from './completionClose';

let lastKnownSize = 0;
let started = false;

interface CompletionEntry {
	thread_id?: string;
	trace_id?: string;
	ticket_id?: string;
	status?: string;
	worker_id?: string;
	summary?: string;
}

// ── Terminal bridge (LOS-196) ───────────────────────────────────────────────

/** Trace prefixes the bridge reconciles — companion-dispatched workers only. */
const BRIDGE_TRACE_PREFIX = /^(sully|rtr)-/;

/**
 * The kernel's single success status, tolerant of the space/underscore
 * variants present in the log ('CONFIRMED_WORKING' / 'CONFIRMED WORKING').
 * Everything else — INCONCLUSIVE, FAILED, ABANDONED, ESCALATE, a missing
 * status — is non-success. Exported only for unit tests.
 */
export function isSuccessMarkerStatus(status: string | null | undefined): boolean {
	if (!status) return false;
	return (
		status
			.trim()
			.toUpperCase()
			.replace(/[\s-]+/g, '_') === 'CONFIRMED_WORKING'
	);
}

/**
 * Honest operator copy for a non-success marker: the marker's own status
 * verbatim plus the first line of its summary. No invented status text —
 * a missing status is described as exactly that. Exported only for unit tests.
 */
export function markerFailureCopy(entry: CompletionEntry): string {
	const status = entry.status?.trim() || 'worker exited without a status marker';
	const reason = (entry.summary ?? '').split('\n')[0].trim().slice(0, 300);
	return reason ? `${status} — ${reason}` : status;
}

/**
 * Map one kernel terminal marker onto the matching IN-FLIGHT job. Returns true
 * when the entry was claimed (job found + close-out ran). Idempotency is
 * layered: a job that already went terminal is skipped here (not in
 * RUNNING_STATES); an FSM race falls into the logs/warns path below; and a
 * late worker callback after a bridge close-out is absorbed by closeOutTask's
 * own synthesis_completed guard. Exported only for unit tests.
 */
export async function bridgeTerminalEntry(entry: CompletionEntry): Promise<boolean> {
	const traceId = entry.trace_id;
	if (!traceId || !BRIDGE_TRACE_PREFIX.test(traceId)) return false;
	const job = getJob(traceId);
	if (!job || !RUNNING_STATES.has(job.status)) return false;
	const summaryLine = (entry.summary ?? '').split('\n')[0].trim();
	if (isSuccessMarkerStatus(entry.status)) {
		// Mirror the activity-route decoupling: an illegal transition must not
		// stop the result from reaching the operator.
		try {
			markDone(traceId, summaryLine || null);
		} catch (e) {
			console.warn('[completion-bridge] markDone transition skipped:', e);
		}
		await closeOutTask(traceId, 'done', summaryLine);
	} else {
		const copy = markerFailureCopy(entry);
		try {
			markFailed(traceId, copy);
		} catch (e) {
			console.warn('[completion-bridge] markFailed transition skipped:', e);
		}
		await closeOutTask(traceId, 'failed', copy);
	}
	return true;
}

/**
 * Build the deep-link a notification tap opens. Always carries `?thread=` so the
 * tap lands in the exact conversation; appends `&trace_id=` when present so the
 * client can focus that task's work-surface card (PR-0c). Both values are
 * URL-encoded.
 */
function buildDeepLinkUrl(base: string, threadId: string, traceId?: string | null): string {
	let u = `${base}?thread=${encodeURIComponent(threadId)}`;
	if (traceId && traceId.trim()) u += `&trace_id=${encodeURIComponent(traceId.trim())}`;
	return u;
}

/** Exported only for unit tests — not part of the public API. */
export async function poll(): Promise<void> {
	const bridgeEnabled = runMode.companionDispatchEnabled;
	if (!serverConfig.enableWebPush && !bridgeEnabled) return;

	try {
		const logPath = serverConfig.completionLogPath;
		if (!fs.existsSync(logPath)) return;

		const stat = fs.statSync(logPath);
		const currentSize = stat.size;

		if (currentSize < lastKnownSize) {
			// File was rotated or truncated — reset pointer
			lastKnownSize = 0;
		}
		if (currentSize === lastKnownSize) return;

		const len = currentSize - lastKnownSize;
		const buf = Buffer.alloc(len);
		const fd = fs.openSync(logPath, 'r');
		fs.readSync(fd, buf, 0, len, lastKnownSize);
		fs.closeSync(fd);
		lastKnownSize = currentSize;

		const lines = buf.toString('utf8').split('\n').filter(Boolean);
		for (const line of lines) {
			let entry: CompletionEntry;
			try {
				entry = JSON.parse(line) as CompletionEntry;
			} catch {
				continue;
			}

			// Terminal bridge first: when it claims the entry, closeOutTask owns
			// the operator message + push for it — skip the legacy push so one
			// marker can never notify twice. One bad entry never kills the loop.
			if (bridgeEnabled) {
				let bridged = false;
				try {
					bridged = await bridgeTerminalEntry(entry);
				} catch (e) {
					console.warn('[completion-bridge] entry skipped:', e);
				}
				if (bridged) continue;
			}

			// Only notify for chat-dispatched workers (those with a thread_id)
			if (!serverConfig.enableWebPush) continue;
			if (!entry.thread_id) continue;

			const ticketLabel = entry.ticket_id ? `${entry.ticket_id} — ` : '';
			const statusLabel = entry.status ?? 'done';
			const badge = incrementBadge();
			sendPushToAll({
				title: 'LogueOS: Worker complete',
				body: `${ticketLabel}${statusLabel}`,
				url: buildDeepLinkUrl(appIdentity.pushDefaultUrl, entry.thread_id, entry.trace_id),
				badge,
				threadGroupId: entry.thread_id
			}).catch(() => {});
		}
	} catch {
		// non-fatal — poller stays alive even if a single poll errors
	}
}

export function startCompletionPoller(): void {
	// Tails the kernel's cc_completion_log.jsonl. Wired mode needs it for the
	// completion push; companion-dispatch mode needs it as the terminal bridge
	// (LOS-196). With neither, there is nothing to tail. hooks.server.ts
	// already gates the call; this is belt-and-suspenders.
	if (!runMode.completionPoller && !runMode.companionDispatchEnabled) return;
	if (started) return;
	started = true;

	// Anchor the size pointer to current EOF so we don't replay on boot
	try {
		const logPath = serverConfig.completionLogPath;
		if (fs.existsSync(logPath)) {
			lastKnownSize = fs.statSync(logPath).size;
		}
	} catch {
		// leave lastKnownSize at 0 — worst case we replay the tail on first poll
	}

	// unref() so this interval never keeps the event loop alive on its own.
	// Otherwise the process won't exit on SIGTERM and systemd has to SIGKILL it
	// (~15s stop hang every restart). The poll still fires every 30s while the
	// server is running; it just no longer blocks a clean shutdown.
	setInterval(() => void poll(), 30_000).unref();
}
