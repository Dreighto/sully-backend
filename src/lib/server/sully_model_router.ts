import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import Database from 'better-sqlite3';

import { serverConfig } from './config';
import type { Tier } from './phase_classifier';
import * as anthropic from './providers/anthropic';
import * as gemini from './providers/gemini';
import * as ollama from './providers/ollama';
import { resolveChatModel } from './model_catalog';

export type SullyBackend = 'local' | 'claude' | 'gemini' | 'ollama_cloud';
export type SullyMode = 'plain' | 'agentic_loop' | 'native_agentic';
export type SpendTrack = 'metered' | 'claude_subscription' | 'free_local';

export type SullyContentPart =
	| { type: 'text'; text: string }
	| { type: 'image'; mimeType: string; base64: string };

export interface SullyRouterMessage {
	role: 'user' | 'assistant';
	content: string | SullyContentPart[];
}

export interface SullyRoutingDecision {
	backend: SullyBackend;
	mode: SullyMode;
	reason: string;
	sensitive: boolean;
	alternatives: Array<{ backend: SullyBackend; mode: SullyMode; reason: string }>;
}

export interface SullyModelResult {
	reply: string;
	provider_used: SullyBackend;
	model_used: string;
	mode_used: SullyMode;
	tokens_used: number;
	fell_forward: boolean;
	trace_id: string;
	decision: SullyRoutingDecision;
}

export interface SpendBackendSnapshot {
	backend: SullyBackend;
	track: SpendTrack;
	calls: number;
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	cost_usd: number;
	cap_usd: number | null;
	remaining_usd: number | null;
}

export interface SullySpendSnapshot {
	month: string;
	month_started_at: string;
	month_ends_at: string;
	claude_subscription: {
		monthly_pool_usd: number;
		rolling_available_usd: number;
		spent_usd: number;
		remaining_usd: number;
		daily_pace_usd: number;
	};
	metered_overflow: {
		cap_usd: number | null;
		spent_usd: number;
		remaining_usd: number | null;
	};
	backends: SpendBackendSnapshot[];
}

interface ProviderResult {
	reply: string;
	usage: { input: number; output: number; total: number };
}

type BackendExecutor = (args: {
	messages: SullyRouterMessage[];
	model: string;
	system?: string;
	signal?: AbortSignal;
	mode: SullyMode;
}) => Promise<ProviderResult>;

export interface SullyModelCallOptions {
	tier: Tier;
	messages: SullyRouterMessage[];
	preference?: 'gemini' | 'anthropic';
	signal?: AbortSignal;
	system?: string;
	traceId?: string;
	taskShape?: string[];
	allowSensitiveCloud?: boolean;
	executors?: Partial<Record<SullyBackend, BackendExecutor>>;
	now?: Date;
	decisionOverride?: SullyRoutingDecision;
}

const ROUTER_DB_VERSION = 1;
const ensuredPaths = new Set<string>();

const BACKEND_TRACK: Record<SullyBackend, SpendTrack> = {
	local: 'free_local',
	claude: 'claude_subscription',
	gemini: 'metered',
	ollama_cloud: 'metered'
};

const MODEL_BY_BACKEND: Record<SullyBackend, () => string> = {
	local: () =>
		process.env.SULLY_LOCAL_MODEL || resolveChatModel({ tier: 'local', provider: 'local' }),
	claude: () =>
		process.env.SULLY_CLAUDE_MODEL || resolveChatModel({ tier: 'planning', provider: 'anthropic' }),
	gemini: () =>
		process.env.SULLY_GEMINI_MODEL || resolveChatModel({ tier: 'chat', provider: 'google' }),
	ollama_cloud: () => `${process.env.SULLY_OLLAMA_CLOUD_MODEL || 'gpt-oss:120b'}-cloud`
};

function getDbPath(): string {
	return process.env.SULLY_ROUTER_DB_PATH || serverConfig.memoryDbPath;
}

function getDb(): Database.Database {
	const dbPath = getDbPath();
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	return new Database(dbPath);
}

function ensureTables(db: Database.Database): void {
	const dbPath = getDbPath();
	if (ensuredPaths.has(dbPath)) return;
	db.pragma(`user_version = ${ROUTER_DB_VERSION}`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS sully_model_spend_ledger (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at TEXT NOT NULL,
			month TEXT NOT NULL,
			date TEXT NOT NULL,
			trace_id TEXT NOT NULL,
			backend TEXT NOT NULL,
			track TEXT NOT NULL,
			mode TEXT NOT NULL,
			model TEXT NOT NULL,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			total_tokens INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_sully_model_spend_month
			ON sully_model_spend_ledger(month, backend, track);
		CREATE TABLE IF NOT EXISTS sully_routing_corpus (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at TEXT NOT NULL,
			trace_id TEXT NOT NULL,
			task_shape_json TEXT NOT NULL,
			decision_json TEXT NOT NULL,
			alternatives_json TEXT NOT NULL,
			outcome_json TEXT NOT NULL
		);
	`);
	ensuredPaths.add(dbPath);
}

function monthKey(now: Date): string {
	return now.toISOString().slice(0, 7);
}

function dateKey(now: Date): string {
	return now.toISOString().slice(0, 10);
}

function monthBounds(now: Date): { start: Date; end: Date } {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
	return { start, end };
}

function dayOfMonth(now: Date): number {
	return now.getUTCDate();
}

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

function claudeMonthlyPoolUsd(): number {
	return envNumber('SULLY_CLAUDE_MONTHLY_POOL_USD', 200);
}

function claudeDailyPaceUsd(): number {
	return envNumber('SULLY_CLAUDE_DAILY_PACE_USD', 6.66);
}

function overflowSpendLimitUsd(): number {
	return envNumber(
		'CONSOLE_OVERFLOW_SPEND_LIMIT_USD',
		envNumber('SULLY_OVERFLOW_SPEND_LIMIT_USD', Infinity)
	);
}

function rollingClaudeAvailableUsd(now: Date): number {
	return Math.min(claudeMonthlyPoolUsd(), claudeDailyPaceUsd() * dayOfMonth(now));
}

function pricePerThousandTokens(backend: SullyBackend): number {
	if (backend === 'claude') return envNumber('SULLY_CLAUDE_CREDIT_USD_PER_1K_TOKENS', 0.015);
	if (backend === 'gemini') return envNumber('SULLY_GEMINI_USD_PER_1K_TOKENS', 0.001);
	if (backend === 'ollama_cloud') return envNumber('SULLY_OLLAMA_CLOUD_USD_PER_1K_TOKENS', 0.001);
	return 0;
}

function estimateCostUsd(backend: SullyBackend, totalTokens: number): number {
	return (Math.max(0, totalTokens) / 1000) * pricePerThousandTokens(backend);
}

function extractText(messages: SullyRouterMessage[]): string {
	return messages
		.map((msg) => {
			if (typeof msg.content === 'string') return msg.content;
			return msg.content
				.filter((part) => part.type === 'text')
				.map((part) => (part as { type: 'text'; text: string }).text)
				.join('\n');
		})
		.join('\n')
		.toLowerCase();
}

function looksSensitive(text: string): boolean {
	return /\b(secret|token|password|private|personal|medical|health|financial|bank|ssn|address|home|family|relationship|journal|diary)\b/.test(
		text
	);
}

function wantsAgentic(text: string): boolean {
	return /\b(agentic|loop|multi[- ]?step|plan and execute|use tools|tool loop|edit files|run tests|open pr|dispatch|investigate)\b/.test(
		text
	);
}

function explicitBackend(text: string): SullyBackend | null {
	if (/\bclaude\b|\banthropic\b/.test(text)) return 'claude';
	if (/\bgemini\b|\bgoogle\b/.test(text)) return 'gemini';
	if (/\bollama cloud\b|\bcloud ollama\b/.test(text)) return 'ollama_cloud';
	if (/\blocal\b|\bjetson\b|\bqwen\b/.test(text)) return 'local';
	return null;
}

function modeFor(backend: SullyBackend, agentic: boolean): SullyMode {
	if (!agentic) return 'plain';
	return backend === 'claude' ? 'native_agentic' : 'agentic_loop';
}

export function decideSullyRoute(args: {
	messages: SullyRouterMessage[];
	preference?: 'gemini' | 'anthropic';
	allowSensitiveCloud?: boolean;
}): SullyRoutingDecision {
	const text = extractText(args.messages);
	const sensitive = looksSensitive(text);
	const agentic = wantsAgentic(text);
	const explicit = explicitBackend(text);

	if (sensitive && !args.allowSensitiveCloud) {
		return {
			backend: 'local',
			mode: modeFor('local', agentic),
			reason: 'Sensitive/private context stays local unless cloud routing is explicitly allowed.',
			sensitive,
			alternatives: [
				{
					backend: 'claude',
					mode: modeFor('claude', agentic),
					reason: 'Cloud candidate withheld by privacy default.'
				},
				{
					backend: 'gemini',
					mode: modeFor('gemini', agentic),
					reason: 'Cloud candidate withheld by privacy default.'
				},
				{
					backend: 'ollama_cloud',
					mode: modeFor('ollama_cloud', agentic),
					reason: 'Cloud candidate withheld by privacy default.'
				}
			]
		};
	}

	const preferred: SullyBackend =
		explicit ??
		(args.preference === 'anthropic'
			? 'claude'
			: args.preference === 'gemini'
				? 'gemini'
				: 'local');
	const ordered = uniqueBackends([preferred, 'local', 'claude', 'gemini', 'ollama_cloud']);

	return {
		backend: ordered[0],
		mode: modeFor(ordered[0], agentic),
		reason: explicit
			? `Explicit backend hint selected ${ordered[0]}.`
			: 'Local model is the default Sully brain.',
		sensitive,
		alternatives: ordered.slice(1).map((backend) => ({
			backend,
			mode: modeFor(backend, agentic),
			reason: backend === 'local' ? 'Local fallback.' : 'Cloud failover candidate.'
		}))
	};
}

function uniqueBackends(backends: SullyBackend[]): SullyBackend[] {
	return [...new Set(backends)];
}

function orderedCandidates(
	decision: SullyRoutingDecision
): Array<{ backend: SullyBackend; mode: SullyMode; reason: string }> {
	return [
		{ backend: decision.backend, mode: decision.mode, reason: decision.reason },
		...decision.alternatives
	];
}

function monthlySpend(
	db: Database.Database,
	trackOrBackend: { track?: SpendTrack; backend?: SullyBackend },
	now: Date
): number {
	const clauses = ['month = ?'];
	const params: Array<string> = [monthKey(now)];
	if (trackOrBackend.track) {
		clauses.push('track = ?');
		params.push(trackOrBackend.track);
	}
	if (trackOrBackend.backend) {
		clauses.push('backend = ?');
		params.push(trackOrBackend.backend);
	}
	const row = db
		.prepare(
			`SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM sully_model_spend_ledger WHERE ${clauses.join(' AND ')}`
		)
		.get(...params) as { cost: number };
	return row.cost ?? 0;
}

function budgetAllows(
	db: Database.Database,
	backend: SullyBackend,
	now: Date
): { ok: boolean; reason?: string } {
	const track = BACKEND_TRACK[backend];
	if (track === 'free_local') return { ok: true };
	if (track === 'claude_subscription') {
		const spent = monthlySpend(db, { backend }, now);
		const available = rollingClaudeAvailableUsd(now);
		if (spent >= available) {
			return {
				ok: false,
				reason: `Claude subscription credit paced out: spent $${spent.toFixed(4)} of rolling $${available.toFixed(4)}.`
			};
		}
		return { ok: true };
	}
	const cap = overflowSpendLimitUsd();
	if (!Number.isFinite(cap)) return { ok: true };
	const spent = monthlySpend(db, { track: 'metered' }, now);
	if (spent >= cap) {
		return {
			ok: false,
			reason: `Console overflow spend limit reached: spent $${spent.toFixed(4)} of $${cap.toFixed(4)}.`
		};
	}
	return { ok: true };
}

function recordSpend(
	db: Database.Database,
	args: {
		now: Date;
		traceId: string;
		backend: SullyBackend;
		mode: SullyMode;
		model: string;
		usage: { input: number; output: number; total: number };
	}
): void {
	db.prepare(
		`
		INSERT INTO sully_model_spend_ledger (
			created_at, month, date, trace_id, backend, track, mode, model,
			input_tokens, output_tokens, total_tokens, cost_usd
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	).run(
		args.now.toISOString(),
		monthKey(args.now),
		dateKey(args.now),
		args.traceId,
		args.backend,
		BACKEND_TRACK[args.backend],
		args.mode,
		args.model,
		args.usage.input,
		args.usage.output,
		args.usage.total,
		estimateCostUsd(args.backend, args.usage.total)
	);
}

function recordCorpus(
	db: Database.Database,
	args: {
		now: Date;
		traceId: string;
		taskShape: string[];
		decision: SullyRoutingDecision;
		outcome: Record<string, unknown>;
	}
): void {
	db.prepare(
		`
		INSERT INTO sully_routing_corpus (
			created_at, trace_id, task_shape_json, decision_json, alternatives_json, outcome_json
		) VALUES (?, ?, ?, ?, ?, ?)
	`
	).run(
		args.now.toISOString(),
		args.traceId,
		JSON.stringify(args.taskShape),
		JSON.stringify({
			backend: args.decision.backend,
			mode: args.decision.mode,
			reason: args.decision.reason,
			sensitive: args.decision.sensitive
		}),
		JSON.stringify(args.decision.alternatives),
		JSON.stringify(args.outcome)
	);
}

const defaultExecutors: Record<SullyBackend, BackendExecutor> = {
	local: async ({ messages, model, system, signal }) =>
		ollama.chat({ messages, model, system, signal }),
	claude: async ({ messages, model, system, signal }) =>
		anthropic.chat({ messages, model, system, signal }),
	gemini: async ({ messages, model, system, signal }) =>
		gemini.chat({ messages, model, system, signal, authMode: 'api_key' }),
	ollama_cloud: async ({ messages, model, system, signal }) =>
		ollama.chat({ messages, model, system, signal })
};

function isBackendAvailable(backend: SullyBackend): boolean {
	if (backend === 'local') return true;
	if (backend === 'claude') return anthropic.isAvailable();
	if (backend === 'gemini') return gemini.isAvailable();
	if (backend === 'ollama_cloud') return !!process.env.OLLAMA_API_KEY;
	return false;
}

function modelForBackend(backend: SullyBackend): string {
	return MODEL_BY_BACKEND[backend]();
}

function statusFromError(err: unknown): number {
	return (err as { status?: number }).status ?? 0;
}

export async function executeSullyModelCall(
	options: SullyModelCallOptions
): Promise<SullyModelResult> {
	const now = options.now ?? new Date();
	const traceId = options.traceId ?? `sully-router-${crypto.randomUUID()}`;
	const decision =
		options.decisionOverride ??
		decideSullyRoute({
			messages: options.messages,
			preference: options.preference,
			allowSensitiveCloud: options.allowSensitiveCloud
		});
	const db = getDb();
	ensureTables(db);
	const executors = { ...defaultExecutors, ...options.executors };
	let fellForward = false;
	const failures: Array<{ backend: SullyBackend; reason: string }> = [];

	try {
		for (const candidate of orderedCandidates(decision)) {
			const backend = candidate.backend;
			const mode = candidate.mode;
			const budget = budgetAllows(db, backend, now);
			if (!budget.ok) {
				fellForward = true;
				failures.push({ backend, reason: budget.reason ?? 'budget denied' });
				continue;
			}
			if (!options.executors?.[backend] && !isBackendAvailable(backend)) {
				fellForward = true;
				failures.push({ backend, reason: 'backend unavailable' });
				continue;
			}

			const model = modelForBackend(backend);
			try {
				const result = await executors[backend]({
					messages: options.messages,
					model,
					system: options.system,
					signal: options.signal,
					mode
				});
				recordSpend(db, {
					now,
					traceId,
					backend,
					mode,
					model,
					usage: result.usage
				});
				recordCorpus(db, {
					now,
					traceId,
					taskShape: options.taskShape ?? ['sully-router'],
					decision,
					outcome: {
						status: 'ok',
						backend,
						mode,
						model,
						fell_forward: fellForward,
						failures
					}
				});
				return {
					reply: result.reply,
					provider_used: backend,
					model_used: model,
					mode_used: mode,
					tokens_used: result.usage.total,
					fell_forward: fellForward,
					trace_id: traceId,
					decision
				};
			} catch (err) {
				fellForward = true;
				failures.push({
					backend,
					reason: `call failed${statusFromError(err) ? ` HTTP ${statusFromError(err)}` : ''}`
				});
			}
		}

		recordCorpus(db, {
			now,
			traceId,
			taskShape: options.taskShape ?? ['sully-router'],
			decision,
			outcome: { status: 'failed', failures }
		});
		throw new Error(`All Sully router backends exhausted: ${JSON.stringify(failures)}`);
	} finally {
		db.close();
	}
}

export function getSullySpendSnapshot(now = new Date()): SullySpendSnapshot {
	const db = getDb();
	ensureTables(db);
	const month = monthKey(now);
	const { start, end } = monthBounds(now);
	try {
		const rows = db
			.prepare(
				`
				SELECT backend, track,
					COUNT(*) AS calls,
					COALESCE(SUM(input_tokens), 0) AS input_tokens,
					COALESCE(SUM(output_tokens), 0) AS output_tokens,
					COALESCE(SUM(total_tokens), 0) AS total_tokens,
					COALESCE(SUM(cost_usd), 0) AS cost_usd
				FROM sully_model_spend_ledger
				WHERE month = ?
				GROUP BY backend, track
			`
			)
			.all(month) as Array<SpendBackendSnapshot>;
		const byBackend = new Map(rows.map((row) => [row.backend, row]));
		const meteredSpent = rows
			.filter((row) => row.track === 'metered')
			.reduce((sum, row) => sum + row.cost_usd, 0);
		const claudeSpent = byBackend.get('claude')?.cost_usd ?? 0;
		const overflowCap = overflowSpendLimitUsd();
		const backends: SpendBackendSnapshot[] = (
			['local', 'claude', 'gemini', 'ollama_cloud'] as SullyBackend[]
		).map((backend) => {
			const existing = byBackend.get(backend);
			const track = BACKEND_TRACK[backend];
			const cap =
				track === 'claude_subscription'
					? rollingClaudeAvailableUsd(now)
					: track === 'metered' && Number.isFinite(overflowCap)
						? overflowCap
						: null;
			const cost = existing?.cost_usd ?? 0;
			return {
				backend,
				track,
				calls: existing?.calls ?? 0,
				input_tokens: existing?.input_tokens ?? 0,
				output_tokens: existing?.output_tokens ?? 0,
				total_tokens: existing?.total_tokens ?? 0,
				cost_usd: cost,
				cap_usd: cap,
				remaining_usd:
					cap === null ? null : Math.max(0, cap - (track === 'metered' ? meteredSpent : cost))
			};
		});
		const rollingAvailable = rollingClaudeAvailableUsd(now);
		return {
			month,
			month_started_at: start.toISOString(),
			month_ends_at: end.toISOString(),
			claude_subscription: {
				monthly_pool_usd: claudeMonthlyPoolUsd(),
				rolling_available_usd: rollingAvailable,
				spent_usd: claudeSpent,
				remaining_usd: Math.max(0, rollingAvailable - claudeSpent),
				daily_pace_usd: claudeDailyPaceUsd()
			},
			metered_overflow: {
				cap_usd: Number.isFinite(overflowCap) ? overflowCap : null,
				spent_usd: meteredSpent,
				remaining_usd: Number.isFinite(overflowCap) ? Math.max(0, overflowCap - meteredSpent) : null
			},
			backends
		};
	} finally {
		db.close();
	}
}
