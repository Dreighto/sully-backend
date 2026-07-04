import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

// Isolate the test run from the real deployment. Without this, tests write to the
// LIVE kernel DB (serverConfig.memoryDbPath defaults to the orchestrator's
// logueos_memory.db in 'wired' mode) — state leaks across runs and causes stale-id
// collisions (e.g. turn-replay's reuse of 'sully-chat-2'), and that absolute path
// doesn't exist on a CI runner. The dispatch prompt write likewise targets the
// orchestrator repo dir, which isn't writable on CI. Fresh temp paths per run fix
// both failures and stop the suite from polluting real data.
const RUN_ID = `${process.pid}-${Date.now()}`;
const TEST_DB = path.join(os.tmpdir(), `sully-test-${RUN_ID}.db`);
const TEST_PROMPT_DIR = path.join(os.tmpdir(), `sully-test-prompts-${RUN_ID}`);

export default defineConfig({
	plugins: [sveltekit()],
	define: {
		__BUILD_VERSION__: JSON.stringify('test'),
		__BUILD_SHA__: JSON.stringify('test-sha')
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		env: {
			LOGUEOS_MEMORY_DB_PATH: TEST_DB,
			LOGUEOS_DISPATCH_PROMPT_DIR: TEST_PROMPT_DIR
		}
	}
});
