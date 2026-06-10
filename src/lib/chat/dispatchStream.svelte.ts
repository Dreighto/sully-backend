import { resolve } from '$app/paths';
import { browser } from '$app/environment';
import { App } from '@capacitor/app';
import { reconcileRows, type StreamRow } from './dispatchReconcile';
import { isTerminalStatus } from '$lib/dispatchActivityView';

export interface DispatchStreamState {
	readonly rows: StreamRow[];
	readonly status: string;
	readonly resultRef: string | null;
	readonly durationLabel: string | null;
	readonly worker: string | null;
	readonly brief: string | null;
	readonly startedAtIso: string | null;
	readonly endedAtIso: string | null;
}

/** SQLite CURRENT_TIMESTAMP is UTC but unmarked; toISOString() carries 'Z'.
 *  Normalize both to a real epoch so the frozen duration is correct on any
 *  device/timezone and on reload. */
function parseTs(s: string | null | undefined): number {
	if (!s) return NaN;
	let v = s.trim().replace(' ', 'T');
	if (!/[zZ]|[+-]\d\d:?\d\d$/.test(v)) v += 'Z';
	return Date.parse(v);
}

/** Human duration computed from start→end timestamps (render-time, reload-proof). */
function fmtDuration(startIso: string | null, endIso: string | null): string | null {
	const start = parseTs(startIso);
	const end = parseTs(endIso);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	const secs = Math.round((end - start) / 1000);
	if (secs < 60) return `${Math.max(secs, 1)}s`;
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins} min`;
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return m ? `${h}h ${m}m` : `${h}h`;
}

export interface DispatchStreamOpts {
	/** Called once when the stream reaches a terminal status (done/failed/error).
	 *  Fires from both SSE __terminal__ frames AND reconcile() seeing a finished
	 *  job. Idempotent: guarded so it only fires once per controller. */
	onTerminal?: (status: string) => void;
	/** Called once when the stream confirms the job is LIVE (non-terminal after
	 *  initial reconcile, so we're opening the SSE). Lets callers spawn UI like
	 *  a work-surface pill only for in-flight dispatches — historic terminal
	 *  ones skip this hook and don't spawn ghost surfaces on chat re-open. */
	onActive?: () => void;
}

// Factory: expose $state via GETTERS (codebase convention for runes modules).
export function createDispatchStream(traceId: string, opts?: DispatchStreamOpts) {
	let rows = $state<StreamRow[]>([]);
	let status = $state('working');
	let resultRef = $state<string | null>(null);
	let startedAtIso = $state<string | null>(null);
	let endedAtIso = $state<string | null>(null);
	// Job metadata for the worker pill (LOS-192). The reconcile endpoint has
	// always returned the full job row; live (non-terminal) fields were simply
	// discarded before. Captured here so the pill can render worker · task ·
	// elapsed for in-flight runs without any new plumbing.
	let worker = $state<string | null>(null);
	let brief = $state<string | null>(null);
	let cursor = 0;
	let es: EventSource | null = null;
	let removeAppResume: (() => void) | null = null;
	let listening = false;
	let terminalFired = false;
	let activeFired = false;

	function fireTerminal() {
		if (terminalFired) return;
		terminalFired = true;
		opts?.onTerminal?.(status);
	}

	function fireActive() {
		if (activeFired || terminalFired) return;
		activeFired = true;
		opts?.onActive?.();
	}

	function ingest(
		seq: number,
		data: {
			action: string;
			target?: string | null;
			status?: string;
			result_ref?: string | null;
			started_at?: string | null;
			ended_at?: string | null;
		}
	) {
		if (data.action === '__terminal__') {
			status = data.status || 'done';
			resultRef = data.result_ref ?? null;
			if (data.started_at) startedAtIso = data.started_at;
			if (data.ended_at) endedAtIso = data.ended_at;
			fireTerminal();
			return;
		}
		const merged = reconcileRows(
			rows,
			[{ seq, action: data.action, target: data.target ?? null }],
			cursor
		);
		rows = merged.rows;
		cursor = merged.cursor;
	}

	function open() {
		es?.close();
		const u = `${resolve('/api/chat/dispatch/stream')}?trace_id=${encodeURIComponent(traceId)}&seq=${cursor}`;
		es = new EventSource(u);
		es.onmessage = (ev) => {
			const seq = Number.parseInt((ev.lastEventId || '').split(':').pop() || '0', 10) || cursor + 1;
			try {
				ingest(seq, JSON.parse(ev.data));
			} catch {
				/* ignore */
			}
			// A terminal frame means the job is done — drop the live stream so a
			// finished card never holds an EventSource open.
			if (isTerminalStatus(status)) es?.close();
		};
		es.onerror = () => {
			// Browser auto-reconnects with Last-Event-ID; resume handler covers
			// the background-kill case explicitly.
		};
	}

	async function reconcile() {
		try {
			const r = await fetch(`${resolve('/api/chat/dispatch')}/${encodeURIComponent(traceId)}`);
			if (!r.ok) return;
			const b = await r.json();
			const fresh: StreamRow[] = (b.activity || []).map(
				(a: { id: number; action: string; target: string | null }) => ({
					seq: a.id,
					action: a.action,
					target: a.target
				})
			);
			const merged = reconcileRows(rows, fresh, cursor);
			rows = merged.rows;
			cursor = merged.cursor;
			if (b.job) {
				// Job metadata is valid live OR terminal — capture unconditionally.
				worker = b.job.worker ?? worker;
				brief = b.job.brief ?? brief;
				startedAtIso = b.job.started_at ?? startedAtIso;
				endedAtIso = b.job.ended_at ?? endedAtIso;
				if (isTerminalStatus(b.job.status)) {
					status = b.job.status;
					resultRef = b.job.result_ref ?? null;
					fireTerminal();
				} else if (b.job.status) {
					// Non-terminal job statuses (dispatched/working/gated/held/retry…)
					// are all equally non-terminal to existing consumers
					// (isTerminalStatus gates every behavior switch), but they let the
					// pill distinguish running from needs-you truthfully.
					status = b.job.status;
				}
			}
		} catch {
			/* offline; SSE will catch up */
		}
	}

	function onVisible() {
		if (document.visibilityState === 'visible') onResume();
	}
	function onResume() {
		void reconcile().then(() => {
			if (!isTerminalStatus(status)) open();
		});
	}

	function start() {
		// EventSource / document / Capacitor App are browser-only. This runs from
		// a template {@const} during SSR too, so bail out server-side.
		if (!browser) return;
		// Resolve from server truth FIRST: a finished job paints its resolved state
		// with no "working" flash, and never opens a live stream (P1 + no N
		// EventSources for historical cards).
		void reconcile().then(() => {
			if (isTerminalStatus(status)) return;
			// Job is LIVE — emit onActive so callers (work-surface pill) can spawn
			// UI for it. Historic terminal jobs already short-circuited above.
			fireActive();
			open();
			if (!listening) {
				listening = true;
				document.addEventListener('visibilitychange', onVisible);
				App.addListener('resume', onResume).then((h) => {
					removeAppResume = () => void h.remove();
				});
			}
		});
	}

	function destroy() {
		es?.close();
		es = null;
		if (listening) document.removeEventListener('visibilitychange', onVisible);
		listening = false;
		removeAppResume?.();
	}

	return {
		get rows() {
			return rows;
		},
		get status() {
			return status;
		},
		get resultRef() {
			return resultRef;
		},
		get durationLabel() {
			return fmtDuration(startedAtIso, endedAtIso);
		},
		get worker() {
			return worker;
		},
		get brief() {
			return brief;
		},
		get startedAtIso() {
			return startedAtIso;
		},
		get endedAtIso() {
			return endedAtIso;
		},
		start,
		destroy
	};
}
