// Layer 3 — Semantic memory: embedding write + similarity recall.
// Embeddings come from a DEDICATED embedding model (nomic-embed-text) via
// Ollama's /api/embed — NOT a chat/coder model (those produce poor-quality,
// slow embeddings). Pull once: `ollama pull nomic-embed-text`.
//
// Vectors are stored as JSON float arrays in episodic_embeddings, tagged with
// the embed model. getRelevantFacts only compares vectors made by the SAME
// model (dimensions/space must match) — so swapping embed models later can't
// silently corrupt cosine scores.

import Database from 'better-sqlite3';
import { serverConfig } from './config';

const OLLAMA_BASE =
	process.env.OLLAMA_BASE_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.COMPANION_EMBED_MODEL || 'nomic-embed-text';

// nomic-embed-text v1.5 expects task prefixes for best retrieval quality:
// stored docs use `search_document:`, queries use `search_query:`.
async function embed(text: string, kind: 'document' | 'query'): Promise<number[]> {
	const input = `${kind === 'query' ? 'search_query' : 'search_document'}: ${text}`;
	const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: EMBED_MODEL, input })
	});
	if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
	const data = (await res.json()) as { embeddings?: number[][]; embedding?: number[] };
	// /api/embed → { embeddings: [[...]] }; legacy /api/embeddings → { embedding: [...] }.
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

/** Store one episodic fact + its embedding. Embeds FIRST so a failed embed
 *  doesn't leave an orphan fact with no vector. */
export async function writeEpisodicFact(
	threadId: string,
	fact: string,
	sourceMessageId?: number,
	importance = 1
): Promise<void> {
	const vector = await embed(fact, 'document');
	const db = new Database(serverConfig.memoryDbPath);
	try {
		const r = db
			.prepare(
				`INSERT INTO episodic_facts (thread_id, fact, source_message_id, importance)
				 VALUES (?, ?, ?, ?)`
			)
			.run(threadId, fact, sourceMessageId ?? null, importance);
		db.prepare(
			`INSERT OR REPLACE INTO episodic_embeddings (fact_id, embedding, embed_model)
			 VALUES (?, ?, ?)`
		).run(r.lastInsertRowid, JSON.stringify(vector), EMBED_MODEL);
	} finally {
		db.close();
	}
}

/** Return up to `topK` stored facts most similar to `query` (cosine >= threshold).
 *  Only compares vectors embedded by the current EMBED_MODEL. */
export async function getRelevantFacts(
	query: string,
	topK = 3,
	threshold = 0.6
): Promise<string[]> {
	if (!query.trim()) return [];
	let rows: { fact: string; embedding: string }[] = [];
	const db = new Database(serverConfig.memoryDbPath, { readonly: true });
	try {
		rows = db
			.prepare(
				`SELECT ef.fact, ee.embedding
				 FROM   episodic_facts ef
				 JOIN   episodic_embeddings ee ON ee.fact_id = ef.id
				 WHERE  ee.embed_model = ?
				 ORDER  BY ef.importance DESC, ef.created_at DESC
				 LIMIT  300`
			)
			.all(EMBED_MODEL) as { fact: string; embedding: string }[];
	} catch {
		return [];
	} finally {
		db.close();
	}
	if (!rows.length) return [];

	const qv = await embed(query, 'query');
	return rows
		.map((r) => ({ fact: r.fact, score: cosine(qv, JSON.parse(r.embedding) as number[]) }))
		.sort((a, b) => b.score - a.score)
		.filter((r) => r.score >= threshold)
		.slice(0, topK)
		.map((r) => r.fact);
}
