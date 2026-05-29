// Background poller that tails cc_completion_log.jsonl and fires a Web Push
// notification when a worker dispatched FROM CHAT (entry has thread_id) completes.
//
// Started once at server boot via hooks.server.ts. Polls every 30 seconds.
// Only reads bytes appended since the last poll — no replay of history on boot.

import fs from 'node:fs';
import { serverConfig, runMode } from './config';
import { sendPushToAll } from './web_push';

let lastKnownSize = 0;
let started = false;

interface CompletionEntry {
	thread_id?: string;
	ticket_id?: string;
	status?: string;
	worker_id?: string;
}

function poll() {
	if (!serverConfig.enableWebPush) return;

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

			// Only notify for chat-dispatched workers (those with a thread_id)
			if (!entry.thread_id) continue;

			const ticketLabel = entry.ticket_id ? `${entry.ticket_id} — ` : '';
			const statusLabel = entry.status ?? 'done';
			sendPushToAll({
				title: 'LogueOS: Worker complete',
				body: `${ticketLabel}${statusLabel}`,
				url: '/console/chat'
			}).catch(() => {});
		}
	} catch {
		// non-fatal — poller stays alive even if a single poll errors
	}
}

export function startCompletionPoller(): void {
	// Tails the kernel's cc_completion_log.jsonl — meaningless in companion mode.
	// hooks.server.ts already gates the call; this is belt-and-suspenders.
	if (!runMode.completionPoller) return;
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
	setInterval(poll, 30_000).unref();
}
