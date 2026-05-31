import { resolve } from '$app/paths';
import { App } from '@capacitor/app';
import { reconcileRows, type StreamRow } from './dispatchReconcile';

export interface DispatchStreamState {
	readonly rows: StreamRow[];
	readonly status: string;
	readonly resultRef: string | null;
}

// Factory: expose $state via GETTERS (codebase convention for runes modules).
export function createDispatchStream(traceId: string) {
	let rows = $state<StreamRow[]>([]);
	let status = $state('working');
	let resultRef = $state<string | null>(null);
	let cursor = 0;
	let es: EventSource | null = null;
	let removeAppResume: (() => void) | null = null;

	function ingest(
		seq: number,
		data: { action: string; target?: string | null; status?: string; result_ref?: string | null }
	) {
		if (data.action === '__terminal__') {
			status = data.status || 'done';
			resultRef = data.result_ref ?? null;
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
			if (b.job && ['done', 'failed', 'aborted'].includes(b.job.status)) {
				status = b.job.status;
				resultRef = b.job.result_ref ?? null;
			}
		} catch {
			/* offline; SSE will catch up */
		}
	}

	function onResume() {
		void reconcile().then(() => open());
	}

	function start() {
		open();
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') onResume();
		});
		App.addListener('resume', onResume).then((h) => {
			removeAppResume = () => void h.remove();
		});
	}

	function destroy() {
		es?.close();
		es = null;
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
		start,
		destroy
	};
}
