// Tier 0 observation emission for chat-sourced observations.
// Writes directly to the observations table in logueos_memory.db.
//
// Extra columns (source, chat_thread_id, tier_at_emit, models_used) are added
// lazily via ALTER TABLE — pre-existing rows and rows written by
// tools/emit_observation.py simply have NULL in these columns, which is fine.
//
// Privacy guard: every body is run through env_redactor before persist.
// Fail-closed — emission is BLOCKED if redaction cannot run.

import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { serverConfig, runMode } from './config';
import { redactEnvValues } from './env_redactor';
import { setRememberFlag, getThreadMeta } from './thread_meta';

export interface ObservationParams {
	source: string;
	thread_id: string;
	tier_at_emit: string;
	models_used: string[];
	project_id: string;
	task_shape: string[];
	body: string;
	observation_kind?: string;
}

export interface ChatObservation {
	id: number;
	observation_id: string;
	project_id: string;
	observation_kind: string;
	text: string;
	task_shape: string[];
	timestamp: string;
	source: string | null;
	chat_thread_id: string | null;
	tier_at_emit: string | null;
	models_used: string[];
}

const ensuredDbs = new Set<string>();

function ensureSchema(db: Database.Database): void {
	const key = serverConfig.memoryDbPath;
	if (ensuredDbs.has(key)) return;

	db.exec(`
		CREATE TABLE IF NOT EXISTS observations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			observation_id TEXT UNIQUE NOT NULL,
			trace_id TEXT,
			ticket_id TEXT,
			project_id TEXT NOT NULL,
			observation_kind TEXT NOT NULL,
			text TEXT NOT NULL,
			task_shape TEXT,
			timestamp TEXT DEFAULT CURRENT_TIMESTAMP
		)
	`);

	// Extra columns for chat-sourced observations. Try each individually;
	// SQLite throws on duplicate column name — catch and continue.
	const extra: [string, string][] = [
		['source', 'TEXT'],
		['chat_thread_id', 'TEXT'],
		['tier_at_emit', 'TEXT'],
		['models_used', 'TEXT']
	];
	for (const [col, type] of extra) {
		try {
			db.exec(`ALTER TABLE observations ADD COLUMN ${col} ${type}`);
		} catch {
			/* already exists */
		}
	}

	ensuredDbs.add(key);
}

/**
 * Emit a Tier 0 observation into the shared logueos_memory.db.
 * Returns false if the privacy redactor fails (fail-closed).
 */
export function emitObservation(params: ObservationParams): {
	ok: boolean;
	reason?: string;
	observation_id?: string;
} {
	// Companion mode: Tier-0 observations are shared-kernel memory. Don't write
	// them (keeps companion.db clean + avoids reading the kernel's .env for the
	// redactor). Belt-and-suspenders alongside the gated callers.
	if (!runMode.observationsEnabled) return { ok: false, reason: 'companion_mode' };
	const redacted = redactEnvValues(params.body);
	if (redacted === null) {
		return { ok: false, reason: 'redaction_failed' };
	}

	if (!fs.existsSync(serverConfig.memoryDbPath)) {
		return { ok: false, reason: 'db_not_found' };
	}

	const db = new Database(serverConfig.memoryDbPath);
	try {
		ensureSchema(db);

		const observation_id = crypto.randomUUID().replace(/-/g, '');
		const ts = new Date().toISOString();
		const extendedShape = [
			...params.task_shape,
			'source:chat_thread',
			`tier:${params.tier_at_emit}`
		];

		db.prepare(
			`
			INSERT INTO observations (
				observation_id, project_id, observation_kind, text, task_shape, timestamp,
				source, chat_thread_id, tier_at_emit, models_used
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`
		).run(
			observation_id,
			params.project_id,
			params.observation_kind ?? 'what-worked',
			redacted.redacted,
			JSON.stringify(extendedShape),
			ts,
			params.source,
			params.thread_id,
			params.tier_at_emit,
			JSON.stringify(params.models_used)
		);

		return { ok: true, observation_id };
	} catch (e) {
		console.error('emitObservation error:', e);
		return { ok: false, reason: String(e) };
	} finally {
		db.close();
	}
}

/**
 * Emit a small linking observation before a chat→worker dispatch so the
 * dispatched worker can receive operator framing as injected memory.
 * Fire-and-forget; errors are logged but not surfaced.
 */
export function emitDispatchLinkObservation(
	threadId: string,
	operatorMessage: string,
	targetRepo: string,
	tier: string
): void {
	const body =
		`Operator dispatched ${targetRepo} worker from chat thread "${threadId}". ` +
		`Context: "${operatorMessage.slice(0, 200)}"`;
	const result = emitObservation({
		source: 'chat_thread',
		thread_id: threadId,
		tier_at_emit: tier,
		models_used: [],
		project_id: targetRepo,
		task_shape: ['dispatch-link', 'chat'],
		body,
		observation_kind: 'what-worked'
	});
	if (!result.ok) {
		console.error('emitDispatchLinkObservation failed:', result.reason);
	}
}

/**
 * When a thread reaches Deep tier with 3+ exchanges, silently mark it as an
 * observation candidate (remember_flag=1). Actual emission only fires on
 * archive or manual flag per §2H.
 */
export function maybeMarkDeepCandidate(threadId: string, tier: string, messageCount: number): void {
	if (!runMode.observationsEnabled) return; // companion mode: no Tier-0 candidacy
	if (tier !== 'deep') return;
	// 6 non-system messages ≈ 3 user + 3 assistant exchanges.
	if (messageCount < 6) return;

	const meta = getThreadMeta(threadId);
	if (meta?.remember_flag) return; // already marked

	try {
		setRememberFlag(threadId, true);
	} catch (e) {
		console.error('maybeMarkDeepCandidate: setRememberFlag failed:', e);
	}
}

/**
 * List recent chat-sourced observations for the Browse modal.
 */
export function listChatObservations(
	limit = 50,
	offset = 0
): { records: ChatObservation[]; today_count: number; lifetime_count: number } {
	if (!fs.existsSync(serverConfig.memoryDbPath)) {
		return { records: [], today_count: 0, lifetime_count: 0 };
	}

	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		ensureSchema(db);

		const today = new Date().toISOString().slice(0, 10);

		const todayRow = db
			.prepare(
				`SELECT COUNT(*) AS count FROM observations WHERE source = 'chat_thread' AND date(timestamp) = ?`
			)
			.get(today) as { count: number };

		const lifetimeRow = db
			.prepare(`SELECT COUNT(*) AS count FROM observations WHERE source = 'chat_thread'`)
			.get() as { count: number };

		const rows = db
			.prepare(
				`SELECT id, observation_id, project_id, observation_kind, text, task_shape, timestamp,
				        source, chat_thread_id, tier_at_emit, models_used
				 FROM observations
				 WHERE source = 'chat_thread'
				 ORDER BY timestamp DESC
				 LIMIT ? OFFSET ?`
			)
			.all(limit, offset) as any[];

		const records: ChatObservation[] = rows.map((r) => ({
			id: r.id,
			observation_id: r.observation_id,
			project_id: r.project_id,
			observation_kind: r.observation_kind,
			text: r.text,
			task_shape: safeParseJson(r.task_shape, []),
			timestamp: r.timestamp,
			source: r.source ?? null,
			chat_thread_id: r.chat_thread_id ?? null,
			tier_at_emit: r.tier_at_emit ?? null,
			models_used: safeParseJson(r.models_used, [])
		}));

		return {
			records,
			today_count: todayRow?.count ?? 0,
			lifetime_count: lifetimeRow?.count ?? 0
		};
	} catch (e) {
		console.error('listChatObservations error:', e);
		return { records: [], today_count: 0, lifetime_count: 0 };
	} finally {
		db.close();
	}
}

/**
 * Delete a specific chat-sourced observation by id. Only allows deleting
 * chat_thread-sourced rows (not worker-emitted observations).
 */
export function deleteChatObservation(observationId: string): { ok: boolean; reason?: string } {
	if (!fs.existsSync(serverConfig.memoryDbPath)) {
		return { ok: false, reason: 'db_not_found' };
	}

	const db = new Database(serverConfig.memoryDbPath);
	try {
		ensureSchema(db);
		const row = db
			.prepare(`SELECT source FROM observations WHERE observation_id = ?`)
			.get(observationId) as { source: string | null } | undefined;

		if (!row) return { ok: false, reason: 'not_found' };
		if (row.source !== 'chat_thread') {
			return { ok: false, reason: 'not_chat_sourced' };
		}

		db.prepare(`DELETE FROM observations WHERE observation_id = ?`).run(observationId);
		return { ok: true };
	} catch (e) {
		console.error('deleteChatObservation error:', e);
		return { ok: false, reason: String(e) };
	} finally {
		db.close();
	}
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}
