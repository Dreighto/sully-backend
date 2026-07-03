// LogueOS system-inspection tools (Phase 1 — READ ONLY).
//
// Purpose: give Sully's chat model the ability to look at the REAL state of the
// LogueOS services on ROOM (are they up? enabled? what do the recent logs say?
// how's disk/memory/reachability?) so it reasons over ground truth instead of
// hallucinating "yeah everything's fine". Anti-hallucination is the whole point.
//
// HARD SAFETY INVARIANTS (do not weaken):
//   1. WHITELIST — only the nine operator-approved units below can ever be
//      inspected. Every unit-scoped function validates against SERVICE_WHITELIST
//      BEFORE it execs anything. A name that isn't on the list is refused.
//   2. NO SHELL — every external command runs via execFile with an ARG ARRAY
//      (never a shell string). A unit name is data, never interpreted, so it
//      cannot inject (`;`, `$()`, backticks, spaces all inert). Belt AND braces:
//      the whitelist check runs first anyway.
//   3. READ ONLY — is-active / is-enabled / show / journalctl / df / free /
//      uptime. Nothing here starts, stops, restarts, or edits anything.
//   4. SECRET SCRUB — journal output is scrubbed of token/key/password-shaped
//      strings before it leaves this module (logs occasionally echo an env line
//      or an auth header). Nothing secret reaches the model, the reply, or the
//      corpus.
//   5. BOUNDED — every exec has a timeout + a maxBuffer cap so a runaway unit
//      can't hang the turn or blow memory.
//
// A JSON line per call is appended to data/system_tool_corpus.jsonl — the
// local-model training sink (what did the model ask about, did it succeed, a
// short scrubbed summary). This file is CREATED by this module if absent; it is
// NOT one of the kernel's protected append-only ledgers.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Whitelist — the single source of truth ──────────────────────────────────
// Exact systemd unit base names (no ".service" suffix). Operator-approved
// 2026-07-02. NOTHING outside this list may be inspected. Exported so the chat
// wiring can build a `z.enum(SERVICE_WHITELIST)` — the model can then only ever
// name a sanctioned unit, and a hallucinated name fails schema validation
// before it can even reach these functions.
export const SERVICE_WHITELIST = [
	'sully-backend',
	'sully-stt',
	'logueos-mcp-gateway',
	'logueos-dispatch-listener',
	'logueos-shadow-loop',
	'logueos-console',
	'logueos-firecrawl-http',
	'logueos-playwright-http',
	'jetson-link-keepalive'
] as const;

export type WhitelistedUnit = (typeof SERVICE_WHITELIST)[number];

const WHITELIST_SET = new Set<string>(SERVICE_WHITELIST);

// Bounds for every external command.
const EXEC_TIMEOUT_MS = 5000;
const EXEC_MAX_BUFFER = 1024 * 1024; // 1 MiB — journalctl caps at 200 lines anyway.

/** Normalise a caller-supplied unit to its whitelist base name, or null. */
function normalizeUnit(input: string): WhitelistedUnit | null {
	if (typeof input !== 'string') return null;
	const base = input.trim().replace(/\.service$/i, '');
	return WHITELIST_SET.has(base) ? (base as WhitelistedUnit) : null;
}

/** True iff `input` (with or without a .service suffix) is a sanctioned unit. */
export function isWhitelisted(input: string): boolean {
	return normalizeUnit(input) !== null;
}

interface RunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	ok: boolean; // exit code 0
	spawnError?: string; // set only when the process could not be run at all
}

// Run an external command via execFile with an ARG ARRAY — no shell, so args
// (a unit name) can never be interpreted. Never rejects on a non-zero exit
// (systemctl is-active returns 3 for an inactive unit, which is a valid answer,
// not a failure); only a genuine spawn failure / timeout is surfaced via
// spawnError. Bounded by timeout + maxBuffer.
function run(cmd: string, args: string[]): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
			(error, stdout, stderr) => {
				const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
				// A spawn failure (ENOENT / EACCES) or a timeout (killed) — the command
				// never produced a real answer. A non-zero exit WITH output is fine.
				const spawned = !err || typeof err.code === 'number' || stdout || stderr;
				resolve({
					stdout: (stdout || '').toString(),
					stderr: (stderr || '').toString(),
					code: err && typeof err.code === 'number' ? err.code : err ? null : 0,
					ok: !err,
					spawnError: spawned
						? undefined
						: `${cmd} failed: ${err?.message || 'unknown spawn error'}`
				});
			}
		);
	});
}

// ── Secret scrubbing ─────────────────────────────────────────────────────────
// Journal lines occasionally echo an env assignment or an auth header. Redact
// anything token/key/password/bearer-shaped BEFORE the text leaves this module.
// Superset of chat/secret_scan.ts's patterns plus assignment/header shapes.
const SCRUB_PATTERNS: RegExp[] = [
	// key=value / key: value where the KEY names a credential (redact the value).
	/\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth|credential|client[_-]?secret)[A-Za-z0-9_.-]*)\s*([=:])\s*("?)[^\s"']+\3/gi,
	// Authorization / Bearer headers.
	/\b(authorization|bearer)\b\s*[:=]?\s*[A-Za-z0-9._~+/=-]{8,}/gi,
	// Provider-specific token shapes (value itself is the secret → full redact).
	/sk-[a-zA-Z0-9]{16,}/g, // OpenAI-style
	/AKIA[0-9A-Z]{12,}/g, // AWS access key id
	/gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub token
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, // JWT
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM block
	/\b[a-f0-9]{40,}\b/gi // long hex (key/hash-ish)
];

/** Redact secret-shaped substrings. Keeps the KEY= prefix, nukes the value. */
export function scrubSecrets(text: string): string {
	let out = text;
	// Assignment / header patterns keep their label ($1) and drop the value.
	out = out.replace(SCRUB_PATTERNS[0], '$1$2[REDACTED]');
	out = out.replace(SCRUB_PATTERNS[1], '$1 [REDACTED]');
	for (let i = 2; i < SCRUB_PATTERNS.length; i++) {
		out = out.replace(SCRUB_PATTERNS[i], '[REDACTED]');
	}
	return out;
}

// ── Corpus sink ──────────────────────────────────────────────────────────────
// One JSON line per tool call. Best-effort: a corpus write must NEVER break the
// tool result the model is waiting on. Created if absent.
function corpusPath(): string {
	const root = process.env.LOGUEOS_SYSTEM_TOOL_ROOT || path.resolve(process.cwd());
	return path.join(root, 'data', 'system_tool_corpus.jsonl');
}

function appendCorpus(entry: {
	tool: string;
	args: Record<string, unknown>;
	ok: boolean;
	result_summary: string;
}): void {
	try {
		const line =
			JSON.stringify({
				ts: new Date().toISOString(),
				tool: entry.tool,
				args: entry.args,
				ok: entry.ok,
				// Scrub the summary too — defence in depth so no secret ever lands in
				// the training sink, and cap its length.
				result_summary: scrubSecrets(String(entry.result_summary)).slice(0, 500)
			}) + '\n';
		const p = corpusPath();
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.appendFileSync(p, line);
	} catch (e) {
		console.error('[systemTools] corpus append failed', (e as Error).message);
	}
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ServiceListEntry {
	unit: string;
	active: string; // active | inactive | failed | activating | unknown
	enabled: string; // enabled | disabled | static | masked | unknown
}

/** Every whitelisted unit's active + enabled state. Real systemctl output. */
export async function serviceList(): Promise<ServiceListEntry[]> {
	const entries = await Promise.all(
		SERVICE_WHITELIST.map(async (unit): Promise<ServiceListEntry> => {
			const svc = `${unit}.service`;
			const [act, en] = await Promise.all([
				run('systemctl', ['is-active', svc]),
				run('systemctl', ['is-enabled', svc])
			]);
			return {
				unit,
				active: act.stdout.trim() || (act.spawnError ? 'unknown' : act.stderr.trim()) || 'unknown',
				enabled: en.stdout.trim() || (en.spawnError ? 'unknown' : en.stderr.trim()) || 'unknown'
			};
		})
	);
	const up = entries.filter((e) => e.active === 'active').length;
	appendCorpus({
		tool: 'serviceList',
		args: {},
		ok: true,
		result_summary: `${up}/${entries.length} active`
	});
	return entries;
}

export interface ServiceStatusResult {
	unit: string;
	active: string;
	enabled: string;
	sub: string; // running | dead | exited | failed …
	since: string; // ActiveEnterTimestamp
	pid: string; // MainPID
}

/** Detailed status for ONE whitelisted unit. Refuses anything else. */
export async function serviceStatus(
	unitInput: string
): Promise<ServiceStatusResult | { error: string; unit: string }> {
	const unit = normalizeUnit(unitInput);
	if (!unit) {
		appendCorpus({
			tool: 'serviceStatus',
			args: { unit: unitInput },
			ok: false,
			result_summary: 'refused: not whitelisted'
		});
		return { error: 'unit_not_whitelisted', unit: String(unitInput) };
	}
	const svc = `${unit}.service`;
	const [act, en, show] = await Promise.all([
		run('systemctl', ['is-active', svc]),
		run('systemctl', ['is-enabled', svc]),
		run('systemctl', ['show', '-p', 'ActiveEnterTimestamp', '-p', 'SubState', '-p', 'MainPID', svc])
	]);
	// `systemctl show` prints KEY=VALUE lines.
	const props: Record<string, string> = {};
	for (const line of show.stdout.split('\n')) {
		const idx = line.indexOf('=');
		if (idx > 0) props[line.slice(0, idx)] = line.slice(idx + 1).trim();
	}
	const result: ServiceStatusResult = {
		unit,
		active: act.stdout.trim() || 'unknown',
		enabled: en.stdout.trim() || 'unknown',
		sub: props['SubState'] || 'unknown',
		since: props['ActiveEnterTimestamp'] || '',
		pid: props['MainPID'] || '0'
	};
	appendCorpus({
		tool: 'serviceStatus',
		args: { unit },
		ok: true,
		result_summary: `${result.active}/${result.sub} pid=${result.pid}`
	});
	return result;
}

export interface ServiceLogsResult {
	unit: string;
	lines: number;
	log: string; // scrubbed journal text
}

/** Recent journal lines for ONE whitelisted unit, secret-scrubbed. Refuses else. */
export async function serviceLogs(
	unitInput: string,
	lines = 40
): Promise<ServiceLogsResult | { error: string; unit: string }> {
	const unit = normalizeUnit(unitInput);
	if (!unit) {
		appendCorpus({
			tool: 'serviceLogs',
			args: { unit: unitInput, lines },
			ok: false,
			result_summary: 'refused: not whitelisted'
		});
		return { error: 'unit_not_whitelisted', unit: String(unitInput) };
	}
	const n = Math.min(Math.max(Math.trunc(Number(lines) || 40), 1), 200);
	const svc = `${unit}.service`;
	const res = await run('journalctl', ['-u', svc, '-n', String(n), '--no-pager', '-o', 'cat']);
	const raw = res.spawnError ? `(journal unavailable: ${res.spawnError})` : res.stdout;
	const scrubbed = scrubSecrets(raw).trim() || '(no recent log lines)';
	appendCorpus({
		tool: 'serviceLogs',
		args: { unit, lines: n },
		ok: !res.spawnError,
		result_summary: `${scrubbed.length} chars, ${n} lines requested`
	});
	return { unit, lines: n, log: scrubbed };
}

export interface SystemHealthResult {
	checked_at: string;
	disk: { mount: string; use_percent: string; avail: string }[];
	memory: { total_mb: number; used_mb: number; free_mb: number; available_mb: number } | null;
	load: { uptime: string; loadavg: string } | null;
	reachability: { name: string; url: string; ok: boolean; status?: number; error?: string }[];
}

// Key local ports Sully depends on. Any HTTP response (even 404) => the process
// is up and listening; connection-refused => down. Short timeouts so a hung
// port can't stall the turn.
const HEALTH_PROBES: { name: string; url: string }[] = [
	{ name: 'sully_backend', url: 'http://127.0.0.1:18779/companion/api/chat/voice-config' },
	{ name: 'mcp_gateway', url: 'http://127.0.0.1:18766/mcp' },
	{ name: 'dispatch_listener', url: 'http://127.0.0.1:19100/healthz' },
	{ name: 'voice_bridge_stt', url: 'http://127.0.0.1:18770/health' },
	{ name: 'voice_bridge_tts', url: 'http://127.0.0.1:18780/health' }
];

/** Disk (/ + data mount), memory, load/uptime, and key-port reachability. */
export async function systemHealth(): Promise<SystemHealthResult> {
	const dataMount = path.join(
		process.env.LOGUEOS_SYSTEM_TOOL_ROOT || path.resolve(process.cwd()),
		'data'
	);

	const [dfRoot, dfData, mem, up, loadavg] = await Promise.all([
		run('df', ['-P', '/']),
		run('df', ['-P', dataMount]),
		run('free', ['-m']),
		run('uptime', []),
		run('cat', ['/proc/loadavg'])
	]);

	// Parse `df -P` — the data row is the 2nd line; use%, avail on it.
	const parseDf = (
		out: string,
		mount: string
	): { mount: string; use_percent: string; avail: string } => {
		const lines = out.trim().split('\n');
		const row = lines[1]?.trim().split(/\s+/);
		if (!row || row.length < 5) return { mount, use_percent: 'unknown', avail: 'unknown' };
		// Columns: Filesystem 1024-blocks Used Available Capacity Mounted-on
		return { mount, use_percent: row[4] || 'unknown', avail: row[3] || 'unknown' };
	};
	const disk = [parseDf(dfRoot.stdout, '/'), parseDf(dfData.stdout, 'data')];

	// Parse `free -m` — the "Mem:" line: total used free shared buff/cache available.
	let memory: SystemHealthResult['memory'] = null;
	const memLine = mem.stdout.split('\n').find((l) => /^Mem:/.test(l.trim()));
	if (memLine) {
		const c = memLine.trim().split(/\s+/);
		memory = {
			total_mb: Number(c[1]) || 0,
			used_mb: Number(c[2]) || 0,
			free_mb: Number(c[3]) || 0,
			available_mb: Number(c[6] ?? c[3]) || 0
		};
	}

	const load = {
		uptime: up.stdout.trim() || 'unknown',
		loadavg: loadavg.stdout.trim().split(' ').slice(0, 3).join(' ') || 'unknown'
	};

	const reachability = await Promise.all(
		HEALTH_PROBES.map(async (p) => {
			try {
				const r = await fetch(p.url, { method: 'GET', signal: AbortSignal.timeout(1500) });
				return { name: p.name, url: p.url, ok: r.status < 500, status: r.status };
			} catch (err) {
				return { name: p.name, url: p.url, ok: false, error: (err as Error).message };
			}
		})
	);

	const upCount = reachability.filter((r) => r.ok).length;
	appendCorpus({
		tool: 'systemHealth',
		args: {},
		ok: true,
		result_summary: `disk / ${disk[0].use_percent}, data ${disk[1].use_percent}; mem ${
			memory ? memory.available_mb + 'MB free' : 'n/a'
		}; ${upCount}/${reachability.length} ports up`
	});

	return {
		checked_at: new Date().toISOString(),
		disk,
		memory,
		load,
		reachability
	};
}
