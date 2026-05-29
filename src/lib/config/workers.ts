// Worker registry — the single source of truth for who the LogueOS workers are.
//
// Everything that used to hard-code "claude-code" / "gemini" now reads from
// here. The raw data lives in workers.json (so windows/start_https.js and
// windows/sync_worker_terminals.ps1 can read the exact same file); this module
// adds the TypeScript types and the lookup helpers the app uses.
//
// To swap or add a worker, edit workers.json — not this file. See the _README
// key in that file for the rules (the short version: never rename an `id`).

import registry from './workers.json';

export type WorkerRole = 'backend' | 'frontend' | 'operator';

export interface WorkerTerminal {
	/** URL path the terminal is proxied under, e.g. "/cc". */
	path: string;
	/** Local ttyd port the terminal listens on. */
	port: number;
}

export interface WorkerDef {
	/** Stable slot key. Never renamed — logs/costs/history reference it. */
	id: string;
	role: WorkerRole;
	/** Operator-facing display name. */
	label: string;
	/** Compact label for badges and dense tables. */
	shortLabel: string;
	/** Brand color (hex). */
	color: string;
	/** Informational only — nothing keys off this. */
	model: string;
	/** Name the dispatch system / gateway routes by. */
	dispatchName: string;
	/** Terminal proxy config, or null if the worker has no terminal. */
	terminal: WorkerTerminal | null;
	/** trace_id prefixes that resolve to this worker (longest match wins). */
	tracePrefixes: string[];
	/** Historical / alternate names so old data still resolves after a swap. */
	aliases: string[];
	enabled: boolean;
}

const FALLBACK_COLOR = '#6B7280';

/** All enabled workers, in roster order. Disabled entries are dropped. */
const WORKERS: WorkerDef[] = (registry.workers as unknown as WorkerDef[]).filter((w) => w.enabled);

/** Every enabled worker (backend, frontend, and operator). */
export function listWorkers(): WorkerDef[] {
	return WORKERS;
}

/** Workers that can be dispatched to — excludes the operator pseudo-worker. */
export function getDispatchWorkers(): WorkerDef[] {
	return WORKERS.filter((w) => w.role === 'backend' || w.role === 'frontend');
}

/** Workers that expose a terminal (drives the proxy + the terminal sync script). */
export function getTerminalWorkers(): WorkerDef[] {
	return WORKERS.filter((w) => w.terminal !== null);
}

/** Exact lookup by stable id. */
export function getWorker(id: string): WorkerDef | undefined {
	return WORKERS.find((w) => w.id === id);
}

/**
 * Resolve any worker reference — id, dispatchName, alias, label, shortLabel, or
 * a suffixed variant like "claude-code-1" — to its registry entry.
 */
export function resolveWorker(name: string | null | undefined): WorkerDef | undefined {
	if (!name) return undefined;
	const n = name.trim();
	if (!n) return undefined;
	const lower = n.toLowerCase();

	// Exact match on any known name (case-insensitive).
	const exact = WORKERS.find((w) =>
		[w.id, w.dispatchName, w.label, w.shortLabel, ...w.aliases]
			.filter(Boolean)
			.some((c) => c.toLowerCase() === lower)
	);
	if (exact) return exact;

	// Suffixed variant — e.g. lease worker "claude-code-1" → dispatchName "claude-code".
	return WORKERS.find((w) =>
		[w.dispatchName, ...w.aliases]
			.filter(Boolean)
			.some((c) => lower.startsWith(c.toLowerCase() + '-'))
	);
}

/**
 * Resolve a worker from a trace_id by its prefix. Longest prefix wins, so a
 * specific prefix like "cc-LOS-" beats the general "cc-".
 */
export function resolveWorkerFromTrace(traceId: string | null | undefined): WorkerDef | undefined {
	if (!traceId) return undefined;
	const pairs: { prefix: string; worker: WorkerDef }[] = [];
	for (const w of WORKERS) {
		for (const p of w.tracePrefixes) pairs.push({ prefix: p, worker: w });
	}
	pairs.sort((a, b) => b.prefix.length - a.prefix.length);
	for (const { prefix, worker } of pairs) {
		if (traceId.startsWith(prefix)) return worker;
	}
	return undefined;
}

/** Display label for any worker reference; falls back to the raw value. */
export function workerLabel(name: string | null | undefined): string {
	return resolveWorker(name)?.label ?? (name || 'Unknown');
}

/** Compact label for any worker reference; falls back to the raw value. */
export function workerShortLabel(name: string | null | undefined): string {
	return resolveWorker(name)?.shortLabel ?? (name || '?');
}

/** Brand color for any worker reference; falls back to a neutral gray. */
export function workerColor(name: string | null | undefined): string {
	return resolveWorker(name)?.color ?? FALLBACK_COLOR;
}

/** Display label for a work lane. */
export function laneLabel(lane: string): string {
	if (lane === 'backend') return 'Backend';
	if (lane === 'frontend') return 'Frontend';
	if (lane === 'operator') return 'Operator';
	return lane ? lane.charAt(0).toUpperCase() + lane.slice(1) : 'Unknown';
}

/** The dispatch lanes the Team screen renders, in display order. */
export function dispatchLanes(): ('backend' | 'frontend')[] {
	const roles = new Set(getDispatchWorkers().map((w) => w.role));
	return (['backend', 'frontend'] as const).filter((l) => roles.has(l));
}
