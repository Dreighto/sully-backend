// SUL-178 — work-context relevance gate + bounded injection block.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const STUB_ENV: Record<string, string> = {
	LOGUEOS_APP_MODE: 'companion',
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
};
vi.mock('$env/dynamic/private', () => ({ env: STUB_ENV }));

/** Fixed 4-dim vectors so cosine is deterministic without Ollama. */
function mockEmbedResponse(vec: number[]) {
	return {
		ok: true,
		json: async () => ({ embeddings: [vec] })
	} as Response;
}

beforeEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
});

describe('isWorkContextQuery', () => {
	it('returns true for work-related turns', async () => {
		const { isWorkContextQuery } = await import('../src/lib/server/work_context');
		expect(isWorkContextQuery('what did we ship today')).toBe(true);
		expect(isWorkContextQuery('status of the sully app')).toBe(true);
		expect(isWorkContextQuery('SUL-177')).toBe(true);
		expect(isWorkContextQuery('any progress on the backend?')).toBe(true);
		expect(isWorkContextQuery('LOS-42 ticket update')).toBe(true);
	});

	it('returns false for unrelated turns', async () => {
		const { isWorkContextQuery } = await import('../src/lib/server/work_context');
		expect(isWorkContextQuery('tell me a joke')).toBe(false);
		expect(isWorkContextQuery('what is the weather')).toBe(false);
		expect(isWorkContextQuery('how are you doing')).toBe(false);
	});
});

describe('buildWorkContextBlock', () => {
	it('returns empty string for non-work queries (gate)', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const { buildWorkContextBlock } = await import('../src/lib/server/work_context');
		const out = await buildWorkContextBlock('tell me a joke');
		expect(out).toBe('');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('buildWorkContextBlockFromChunks — char cap', () => {
	it('enforces WORK_CONTEXT_CHAR_CAP (<=1500)', async () => {
		const { buildWorkContextBlockFromChunks, WORK_CONTEXT_CHAR_CAP } = await import(
			'../src/lib/server/work_context'
		);
		const long = 'x'.repeat(600);
		const block = buildWorkContextBlockFromChunks([long, long, long, long]);
		expect(block.length).toBeLessThanOrEqual(WORK_CONTEXT_CHAR_CAP);
		expect(block).toMatch(/What we've been working on/);
	});
});

describe('getRelevantWorkContext — hermetic embed mock', () => {
	it('returns chunks above threshold when vectors align', async () => {
		const docVec = [1, 0, 0, 0];
		const queryVec = [0.99, 0.01, 0, 0];
		let call = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				call++;
				return mockEmbedResponse(call === 1 ? queryVec : docVec);
			})
		);

		const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
		const { join } = await import('node:path');
		const { tmpdir } = await import('node:os');
		const dbPath = join(tmpdir(), `work-context-test-${Date.now()}.db`);
		STUB_ENV.LOGUEOS_MEMORY_DB_PATH = dbPath;

		const Database = (await import('better-sqlite3')).default;
		mkdirSync(join(dbPath, '..'), { recursive: true });
		const db = new Database(dbPath);
		db.exec(`
			CREATE TABLE work_knowledge (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source TEXT, source_key TEXT UNIQUE, chunk TEXT, content_hash TEXT,
				importance INTEGER DEFAULT 1, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE work_knowledge_embeddings (
				chunk_id INTEGER PRIMARY KEY, embedding TEXT, embed_model TEXT
			);
		`);
		const r = db
			.prepare('INSERT INTO work_knowledge (source, source_key, chunk, content_hash) VALUES (?,?,?,?)')
			.run('test', 'k1', 'shipped the auth fix', 'abc');
		db.prepare('INSERT INTO work_knowledge_embeddings (chunk_id, embedding, embed_model) VALUES (?,?,?)').run(
			r.lastInsertRowid,
			JSON.stringify(docVec),
			'mxbai-embed-large'
		);
		db.close();

		const { getRelevantWorkContext } = await import('../src/lib/server/work_context');
		const chunks = await getRelevantWorkContext('what did we ship', 4, 0.5);
		expect(chunks).toContain('shipped the auth fix');

		rmSync(dbPath, { force: true });
	});
});
