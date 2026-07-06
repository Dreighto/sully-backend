// Layer 3 — Semantic memory: embedding write + similarity recall.
// Embeddings come from a DEDICATED embedding model via Ollama's /api/embed —
// NOT a chat/coder model (those produce poor, slow embeddings).
//
// Default: mxbai-embed-large. Tuning (2026-05-30) showed it ranks the correct
// fact #1 on hard/oblique queries where nomic-embed-text did not, and it
// separates relevant (cosine ~0.49–0.73) from irrelevant (~0.33) cleanly — so a
// 0.42 floor catches real matches and rejects noise. Pull: `ollama pull
// mxbai-embed-large`. Override with COMPANION_EMBED_MODEL if desired.
//
// Vectors are stored tagged with the embed model; getRelevantFacts only compares
// vectors made by the SAME model, so swapping models can't corrupt cosine.

import Database from 'better-sqlite3';
import { serverConfig } from './config';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.COMPANION_EMBED_MODEL || 'mxbai-embed-large';
const DEFAULT_THRESHOLD = Number(process.env.COMPANION_SEMANTIC_THRESHOLD || '0.42');

// Each embed model wants its own task-prefix scheme for best retrieval.
function withPrefix(text: string, kind: 'document' | 'query'): string {
	if (EMBED_MODEL.startsWith('nomic')) {
		return `${kind === 'query' ? 'search_query' : 'search_document'}: ${text}`;
	}
	if (EMBED_MODEL.startsWith('mxbai')) {
		// mxbai prefixes ONLY the query side.
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
	threshold = DEFAULT_THRESHOLD
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
