import { resolveWorkerFromTrace } from '$lib/config/workers';

// Parse a timestamp string from the kernel data sources (SQLite, JSONL logs).
//
// SQLite's CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" in UTC, with no
// timezone marker. JavaScript's `new Date(str)` parses ISO-formatted strings
// in local time when no zone is given, so "2026-05-25 18:37:09" coming out
// of SQLite gets interpreted as 6:37 PM local — but it's really 6:37 PM UTC
// (= 11:37 AM Pacific). Result: every chat / activity / memory timestamp
// renders 7-8 hours off for any operator outside UTC.
//
// Fix: detect the SQLite shape (no T, no Z, no offset) and append 'Z' so
// JS parses it as UTC. Then toLocaleString / toLocaleTimeString uses the
// operator's actual locale to render. JSONL chains and ISO strings already
// carry a zone marker so they pass through untouched.
export function parseDbTimestamp(timestamp: string | null | undefined): Date | null {
	if (!timestamp) return null;
	const s = String(timestamp).trim();
	// Shape detection: ISO date present, but no zone marker means SQLite-UTC.
	const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
	const looksDatey = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s);
	const normalized = looksDatey && !hasZone ? s.replace(' ', 'T') + 'Z' : s;
	const d = new Date(normalized);
	return isNaN(d.getTime()) ? null : d;
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return '';
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = seconds / 60;
	return `${minutes.toFixed(1)}m`;
}

export function formatRelativeTime(timestamp: string): string {
	const date = parseDbTimestamp(timestamp);
	if (!date) return '—';

	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffSec = Math.floor(diffMs / 1000);
	if (diffSec < 60) return `${diffSec}s ago`;
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHour = Math.floor(diffMin / 60);
	if (diffHour < 24) return `${diffHour}h ago`;
	const diffDay = Math.floor(diffHour / 24);
	return `${diffDay}d ago`;
}

export function truncateTraceId(traceId: string | null | undefined): string {
	// CodeRabbit Minor: previously was '—' (mojibake — UTF-8 em-dash
	// bytes interpreted as Latin-1 by gemini's PowerShell pipe). Now
	// the actual em-dash codepoint U+2014.
	if (!traceId) return '—';
	// Extract the last 8 chars if it's a long trace ID (e.g. cc-LOS-1-...)
	// Usually they end with a hash
	const parts = traceId.split('-');
	const lastPart = parts[parts.length - 1];
	if (lastPart.length === 8) return lastPart;
	return traceId.slice(-8);
}

export function deriveWorkerFromTraceId(traceId: string | null | undefined): string {
	// Worker identity + trace prefixes are registry-driven — see workers.json.
	return resolveWorkerFromTrace(traceId)?.id ?? 'unknown';
}

export function formatFullDate(timestamp: string): string {
	const date = parseDbTimestamp(timestamp);
	if (!date) return '—';
	return date.toLocaleString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		timeZoneName: 'short'
	});
}

// Short HH:MM time, locale-aware. Used in chat bubbles + activity rows.
export function formatShortTime(timestamp: string): string {
	const date = parseDbTimestamp(timestamp);
	if (!date) return '';
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
