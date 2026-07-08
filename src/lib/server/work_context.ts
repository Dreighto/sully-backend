// Work-context retrieval — gated, capped injection of LogueOS work knowledge.
// Mirrors semantic.ts (mxbai-embed-large via Ollama, cosine recall). Only
// surfaces chunks when the turn is work-related (isWorkContextQuery) so
// unrelated chat gets zero extra prompt bytes.

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { serverConfig } from './config';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.COMPANION_EMBED_MODEL || 'mxbai-embed-large';
export const DEFAULT_THRESHOLD = Number(process.env.COMPANION_SEMANTIC_THRESHOLD || '0.42');
export const WORK_CONTEXT_CHAR_CAP = 1500;

const WORK_KEYWORD_RE =
	/\b(ship|build|shipped|status|working on|progress|dispatch|project|kernel|wave|ticket|backend|the app|what did we|what have we)\b|LOS-\d+|SUL-\d+/i;

function withPrefix(text: string, kind: 'document' | 'query'): string {
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

async function embed(text: string, kind: 'document' | 'query'): Promise<number[]> {
	const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: EMBED_MODEL, input: withPrefix(text, kind) })
	});
	if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
	const data = (await res.json()) as { embeddings?: number[][]; embedding?: number[] };
	const vec = data.embeddings?.[0] ?? data.embedding;
	if (!Array.isArray(vec) || !vec.length) throw new Error('embed: no vector in response');
	return vec;
}

function cosine(a: number[], b: number[]): number {
	if (a.length !== b.length) return -1;
	let dot = 0,
		na = 0,
		nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom ? dot / denom : 0;
}

function contentHash(chunk: string): string {
	return createHash('sha256').update(chunk, 'utf8').digest('hex');
}

/** Cheap relevance gate — unrelated turns skip retrieval entirely (anti-bloat). */
export function isWorkContextQuery(text: string): boolean {
	return WORK_KEYWORD_RE.test(text.trim());
}

export type UpsertResult = 'upserted' | 'skipped_unchanged';

/** Embed + UPSERT one work chunk. Skips re-embed when content_hash is unchanged. */
export async function upsertWorkChunk(
	source: string,
	sourceKey: string,
	chunk: string,
	importance = 1
): Promise<UpsertResult> {
	const hash = contentHash(chunk);
	const db = new Database(serverConfig.memoryDbPath);
	try {
		const existing = db
			.prepare('SELECT id, content_hash FROM work_knowledge WHERE source_key = ?')
			.get(sourceKey) as { id: number; content_hash: string } | undefined;

		if (existing?.content_hash === hash) {
			return 'skipped_unchanged';
		}

		const vector = await embed(chunk, 'document');

		if (existing) {
			db.prepare(
				`UPDATE work_knowledge
				 SET source = ?, chunk = ?, content_hash = ?, importance = ?, updated_at = CURRENT_TIMESTAMP
				 WHERE id = ?`
			).run(source, chunk, hash, importance, existing.id);
			db.prepare(
				`INSERT OR REPLACE INTO work_knowledge_embeddings (chunk_id, embedding, embed_model)
				 VALUES (?, ?, ?)`
			).run(existing.id, JSON.stringify(vector), EMBED_MODEL);
		} else {
			const r = db
				.prepare(
					`INSERT INTO work_knowledge (source, source_key, chunk, content_hash, importance)
					 VALUES (?, ?, ?, ?, ?)`
				)
				.run(source, sourceKey, chunk, hash, importance);
			db.prepare(
				`INSERT INTO work_knowledge_embeddings (chunk_id, embedding, embed_model)
				 VALUES (?, ?, ?)`
			).run(r.lastInsertRowid, JSON.stringify(vector), EMBED_MODEL);
		}
		return 'upserted';
	} finally {
		db.close();
	}
}

/** Cosine-ranked work chunks for `query`, threshold-gated. */
export async function getRelevantWorkContext(
	query: string,
	topK = 4,
	threshold = DEFAULT_THRESHOLD
): Promise<string[]> {
	if (!query.trim()) return [];
	let rows: { chunk: string; embedding: string; importance: number }[] = [];
	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		rows = db
			.prepare(
				`SELECT wk.chunk, wke.embedding, wk.importance
				 FROM   work_knowledge wk
				 JOIN   work_knowledge_embeddings wke ON wke.chunk_id = wk.id
				 WHERE  wke.embed_model = ?
				 ORDER  BY wk.importance DESC, wk.updated_at DESC
				 LIMIT  500`
			)
			.all(EMBED_MODEL) as { chunk: string; embedding: string; importance: number }[];
	} catch {
		return [];
	} finally {
		db.close();
	}
	if (!rows.length) return [];

	const qv = await embed(query, 'query');
	return rows
		.map((r) => ({
			chunk: r.chunk,
			score: cosine(qv, JSON.parse(r.embedding) as number[])
		}))
		.sort((a, b) => b.score - a.score)
		.filter((r) => r.score >= threshold)
		.slice(0, topK)
		.map((r) => r.chunk);
}

/** Join ranked chunks into the injection block, hard-capped at WORK_CONTEXT_CHAR_CAP. */
export function buildWorkContextBlockFromChunks(chunks: string[]): string {
	if (!chunks.length) return '';
	const header = "\n\n## What we've been working on (relevant to this)\n";
	const prefix = '- ';
	let body = chunks.map((c) => `${prefix}${c}`).join('\n');
	let block = `${header}${body}`;

	while (block.length > WORK_CONTEXT_CHAR_CAP && chunks.length > 1) {
		chunks = chunks.slice(0, -1);
		body = chunks.map((c) => `${prefix}${c}`).join('\n');
		block = `${header}${body}`;
	}

	if (block.length > WORK_CONTEXT_CHAR_CAP) {
		const maxBody = WORK_CONTEXT_CHAR_CAP - header.length - prefix.length;
		if (maxBody <= 0) return '';
		block = `${header}${prefix}${chunks[0]!.slice(0, maxBody)}`;
	}

	return block.length <= WORK_CONTEXT_CHAR_CAP ? block : block.slice(0, WORK_CONTEXT_CHAR_CAP);
}

/** Gated work-context block for system-prompt injection. Returns '' when not work-related. */
export async function buildWorkContextBlock(query: string): Promise<string> {
	if (!isWorkContextQuery(query)) return '';
	try {
		const chunks = await getRelevantWorkContext(query);
		if (!chunks.length) return '';
		return buildWorkContextBlockFromChunks(chunks);
	} catch {
		return '';
	}
}
