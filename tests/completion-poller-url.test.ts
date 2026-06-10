// Tests that the completion_poller sends push notifications with ?thread=<id>
// deep-link URLs, so tapping a poller-fired notification opens the right thread.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_PATH = path.join(os.tmpdir(), 'sully-poller-url-test.jsonl');

const ENV = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: path.join(os.tmpdir(), 'sully-poller-url-test.db'),
	ENABLE_WEB_PUSH: 'true',
	LOGUEOS_COMPLETION_LOG_PATH: LOG_PATH,
	// Minimal required keys to keep config from erroring:
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
};

vi.mock('$env/dynamic/private', () => ({ env: ENV }));

const webPushPayloads: unknown[] = [];
vi.mock('$lib/server/web_push', () => ({
	sendPushToAll: vi.fn(async (payload: unknown) => {
		webPushPayloads.push(payload);
	})
}));

function wipe() {
	for (const f of [LOG_PATH]) if (fs.existsSync(f)) fs.unlinkSync(f);
	webPushPayloads.length = 0;
}

beforeEach(() => {
	wipe();
	vi.resetModules();
});
afterEach(() => {
	wipe();
});

describe('completion_poller push URL carries thread id (deep-link fix)', () => {
	it('fires sendPushToAll with ?thread=<id>&trace_id=<id> for an entry carrying both', async () => {
		// Write a completion log entry with a thread_id + trace_id (PR-0c deep-link).
		const entry = JSON.stringify({
			thread_id: 'thread-xyz789',
			trace_id: 'sully-1717-abcd',
			ticket_id: 'CC-42',
			status: 'done',
			worker_id: 'cc'
		});
		fs.writeFileSync(LOG_PATH, entry + '\n', 'utf8');

		// Import after mocks are in place (resetModules ensures fresh module state).
		// Re-register mocks after reset (hoisting still captures top-level vi.mock calls).
		const { poll } = await import('$lib/server/completion_poller');
		poll();

		expect(webPushPayloads.length).toBe(1);
		const payload = webPushPayloads[0] as { url?: string; title?: string };
		expect(payload.url).toContain('?thread=');
		expect(payload.url).toContain('thread-xyz789');
		// PR-0c: the trace_id rides along so the tap can focus the task card.
		expect(payload.url).toContain('trace_id=');
		expect(payload.url).toContain('sully-1717-abcd');
	});

	it('omits trace_id from the URL when the entry has no trace_id', async () => {
		const entry = JSON.stringify({ thread_id: 'thread-no-trace', status: 'done' });
		fs.writeFileSync(LOG_PATH, entry + '\n', 'utf8');

		const { poll } = await import('$lib/server/completion_poller');
		poll();

		expect(webPushPayloads.length).toBe(1);
		const payload = webPushPayloads[0] as { url?: string };
		expect(payload.url).toContain('?thread=');
		expect(payload.url).toContain('thread-no-trace');
		expect(payload.url).not.toContain('trace_id=');
	});

	it('does NOT fire for entries without a thread_id (non-chat workers)', async () => {
		// An entry with no thread_id (dispatched outside chat) should not ping
		const entry = JSON.stringify({ ticket_id: 'CC-99', status: 'done', worker_id: 'cc' });
		fs.writeFileSync(LOG_PATH, entry + '\n', 'utf8');

		const { poll } = await import('$lib/server/completion_poller');
		poll();

		expect(webPushPayloads.length).toBe(0);
	});

	it('correctly URL-encodes special characters in thread_id', async () => {
		const entry = JSON.stringify({ thread_id: 'thread with spaces & chars', status: 'done' });
		fs.writeFileSync(LOG_PATH, entry + '\n', 'utf8');

		const { poll } = await import('$lib/server/completion_poller');
		poll();

		expect(webPushPayloads.length).toBe(1);
		const payload = webPushPayloads[0] as { url?: string };
		// encodeURIComponent('thread with spaces & chars') = 'thread%20with%20spaces%20%26%20chars'
		expect(payload.url).toContain(encodeURIComponent('thread with spaces & chars'));
		expect(payload.url).not.toContain(' ');
	});
});
