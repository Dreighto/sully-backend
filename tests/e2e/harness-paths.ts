// Shared path resolution for the hermetic e2e harness (LOS-182).
//
// playwright.config.ts evaluates this in Playwright's main runner process and
// passes the paths into the webServer env (LOGUEOS_MEMORY_DB_PATH /
// LOGUEOS_CHAT_UPLOADS_DIR); prep-run-dir.mjs — the first half of the
// webServer command — derives the run dir back from that env, so the two
// never disagree. The run id comes from the main process pid. (Worker
// processes re-evaluate the config with a different pid, but workers never
// read these paths — only the main process spawns the webServer.)
//
// The run dir lives under .e2e-data/ (gitignored), NOT test-results/ —
// Playwright clears its outputDir at run start, which would race the
// webServer's DB file.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const E2E_DATA_ROOT = join(repoRoot, '.e2e-data');

/** One fresh, isolated state dir per suite invocation — hermetic per-run DB. */
const RUN_DIR = join(E2E_DATA_ROOT, `run-${process.pid}`);

export const RUN_DB_PATH = join(RUN_DIR, 'companion.db');
export const RUN_UPLOADS_DIR = join(RUN_DIR, 'chat_uploads');
