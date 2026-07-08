#!/usr/bin/env node
// Manual ingest of work-context sources into work_knowledge (SUL-178 phase 1).
// Mirrors src/lib/server/work_context.ts upsert logic. Run on the maintainer host
// with Ollama up — NOT against prod from CI.
//
// Usage: node --env-file=.env tools/ingest-work-context.mjs
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const EMBED_MODEL = process.env.COMPANION_EMBED_MODEL || 'mxbai-embed-large';
const DB_PATH =
	process.env.LOGUEOS_MEMORY_DB_PATH ||
	process.env.COMPANION_MEMORY_DB_PATH ||
	'/home/dreighto/dev/sully-backend/data/companion.db'; // backend's DB (systemd LOGUEOS_MEMORY_DB_PATH)

const DEV = process.env.HOME ? join(process.env.HOME, 'dev') : join(homedir(), 'dev');

const SOURCES = {
	shipLog: join(DEV, 'LogueOS-Orchestrator/data/cc_completion_log.jsonl'),
	currentLane: join(DEV, 'LogueOS-Orchestrator/.logueos/context/current_lane.md'),
	projectMemoryDir: join(
		homedir(),
		'.claude/projects/-home-dreighto-dev/memory'
	)
};

function contentHash(chunk) {
	return createHash('sha256').update(chunk, 'utf8').digest('hex');
}

function withPrefix(text, kind) {
	if (EMBED_MODEL.startsWith('nomic')) {
		return `${kind === 'query' ? 'search_query' : 'search_document'}: ${text}`;
	}
	if (EMBED_MODEL.startsWith('mxbai')) {
		return kind === 'query'
			? `Represent this sentence for searching relevant passages: ${text}`
			: text;
	}
	return text;
}

async function embed(text) {
	const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: EMBED_MODEL, input: withPrefix(text, 'document') })
	});
	if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
	const data = await res.json();
	const vec = data.embeddings?.[0] ?? data.embedding;
	if (!Array.isArray(vec) || !vec.length) throw new Error('embed: no vector in response');
	return vec;
}

function ensureSchema(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS work_knowledge (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			source TEXT NOT NULL,
			source_key TEXT UNIQUE NOT NULL,
			chunk TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			importance INTEGER DEFAULT 1,
			updated_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS work_knowledge_embeddings (
			chunk_id INTEGER PRIMARY KEY REFERENCES work_knowledge(id) ON DELETE CASCADE,
			embedding TEXT NOT NULL,
			embed_model TEXT NOT NULL
		);
	`);
}

function upsertChunk(db, source, sourceKey, chunk, importance = 1) {
	const hash = contentHash(chunk);
	const existing = db
		.prepare('SELECT id, content_hash FROM work_knowledge WHERE source_key = ?')
		.get(sourceKey);
	if (existing?.content_hash === hash) {
		return 'skipped_unchanged';
	}
	return { source, sourceKey, chunk, hash, importance, existingId: existing?.id ?? null };
}

async function commitUpsert(db, pending) {
	const vector = await embed(pending.chunk);
	// Atomic upsert: duplicate source_keys within one run (e.g. repeated
	// trace_ids in the ship log) planned separately during the SELECT phase
	// would otherwise collide on INSERT and abort the whole ingest. ON CONFLICT
	// makes the second write an UPDATE. (2026-07-07 ingest-crash fix.)
	db.prepare(
		`INSERT INTO work_knowledge (source, source_key, chunk, content_hash, importance)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(source_key) DO UPDATE SET
		   source = excluded.source, chunk = excluded.chunk,
		   content_hash = excluded.content_hash, importance = excluded.importance,
		   updated_at = CURRENT_TIMESTAMP`
	).run(pending.source, pending.sourceKey, pending.chunk, pending.hash, pending.importance);
	const row = db.prepare('SELECT id FROM work_knowledge WHERE source_key = ?').get(pending.sourceKey);
	db.prepare(
		`INSERT OR REPLACE INTO work_knowledge_embeddings (chunk_id, embedding, embed_model)
		 VALUES (?, ?, ?)`
	).run(row.id, JSON.stringify(vector), EMBED_MODEL);
	return 'upserted';
}

function slugify(text) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 80);
}

const SECRET_LINE_PATTERNS = [
	/sk-[a-zA-Z0-9]{16,}/g,
	/gh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	/AKIA[0-9A-Z]{12,}/g,
	/(?:HMAC|secret)\s*=\s*\S+/gi,
	/\b[a-f0-9]{32,}\b/gi
];

const REMAINING_SECRET_RE =
	/sk-[a-zA-Z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|AKIA[0-9A-Z]{12,}|(?:HMAC|secret)\s*=\s*\S+|\b[a-f0-9]{32,}\b/i;

/** Mask likely secret substrings line-by-line before embed/upsert. */
function redact(text) {
	return text
		.split('\n')
		.map((line) => {
			let out = line;
			for (const re of SECRET_LINE_PATTERNS) {
				out = out.replace(re, '[redacted]');
			}
			return out;
		})
		.join('\n');
}

function isSecretDense(text) {
	if (REMAINING_SECRET_RE.test(text)) return true;
	const lines = text.split('\n').filter((l) => l.trim());
	if (!lines.length) return false;
	let hits = 0;
	for (const line of lines) {
		if (REMAINING_SECRET_RE.test(line)) hits++;
	}
	return hits / lines.length > 0.15;
}

function prepareChunk(raw) {
	const chunk = redact(raw).trim();
	if (!chunk) return null;
	if (isSecretDense(chunk)) {
		console.warn('skip chunk: still secret-dense after redaction');
		return null;
	}
	return chunk;
}

function readTextFile(path, label) {
	try {
		return readFileSync(path, 'utf8');
	} catch (err) {
		console.warn(`skip ${label}: cannot read ${path}: ${err?.message || err}`);
		return null;
	}
}

function ingestShipLog(db, stats) {
	if (!existsSync(SOURCES.shipLog)) {
		console.warn(`skip ship_log: missing ${SOURCES.shipLog}`);
		return;
	}
	const lines = readFileSync(SOURCES.shipLog, 'utf8').trim().split('\n').filter(Boolean);
	const tail = lines.slice(-200);
	for (const line of tail) {
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		const traceId = row.trace_id || row.traceId;
		if (!traceId) continue;
		const date = row.ts || row.timestamp || row.date || 'unknown';
		const status = row.status || row.verdict || 'unknown';
		const summary = row.summary || row.message || row.subject || '';
		if (!summary) continue;
		const chunk = prepareChunk(`${date} · ${status} · ${summary}`);
		if (!chunk) continue;
		const result = upsertChunk(db, 'ship_log', traceId, chunk);
		if (result === 'skipped_unchanged') stats.skipped++;
		else stats.pending.push(result);
	}
}

function ingestCurrentLane(db, stats) {
	if (!existsSync(SOURCES.currentLane)) {
		console.warn(`skip current_lane: missing ${SOURCES.currentLane}`);
		return;
	}
	const text = readTextFile(SOURCES.currentLane, 'current_lane');
	if (!text) return;
	const sections = text.split(/^## /m).filter(Boolean);
	for (const section of sections) {
		const lines = section.trim().split('\n');
		const title = lines[0]?.trim() || 'section';
		const body = lines.slice(1).join('\n').trim();
		const raw = body ? `## ${title}\n${body}` : `## ${title}`;
		const chunk = prepareChunk(raw);
		if (!chunk) continue;
		const key = `lane#${slugify(title)}`;
		const result = upsertChunk(db, 'current_lane', key, chunk, 2);
		if (result === 'skipped_unchanged') stats.skipped++;
		else stats.pending.push(result);
	}
}

function ingestProjectMemory(db, stats) {
	if (!existsSync(SOURCES.projectMemoryDir)) {
		console.warn(`skip project_memory: missing ${SOURCES.projectMemoryDir}`);
		return;
	}
	const files = readdirSync(SOURCES.projectMemoryDir).filter((f) => f.startsWith('project_') && f.endsWith('.md'));
	for (const file of files) {
		const text = readTextFile(join(SOURCES.projectMemoryDir, file), `project_memory:${file}`);
		if (!text) continue;
		const lines = text.trim().split('\n');
		const heading = lines.find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '') || file;
		const description = lines.find((l) => l.trim() && !l.startsWith('#'))?.trim() || '';
		const raw = description ? `${heading}: ${description}` : heading;
		const chunk = prepareChunk(raw);
		if (!chunk) continue;
		const result = upsertChunk(db, 'project_memory', file, chunk);
		if (result === 'skipped_unchanged') stats.skipped++;
		else stats.pending.push(result);
	}
}

async function main() {
	const db = new Database(DB_PATH);
	ensureSchema(db);
	const stats = { upserted: 0, skipped: 0, pending: [] };

	try {
		ingestShipLog(db, stats);
		ingestCurrentLane(db, stats);
		ingestProjectMemory(db, stats);

		for (const pending of stats.pending) {
			await commitUpsert(db, pending);
			stats.upserted++;
		}
	} finally {
		db.close();
	}

	console.log(`ingest summary: ${stats.upserted} upserted, ${stats.skipped} skipped-unchanged`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
