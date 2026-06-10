// Shared path resolution for the hermetic e2e harness (LOS-182).
//
// Both playwright.config.ts and global-setup.ts need the SAME per-run paths,
// and both execute in Playwright's main runner process — so deriving the run
// id from process.pid is stable across the two without any side-channel.
// (Worker processes re-evaluate the config with a different pid, but workers
// never read these paths — only the main process spawns the webServer.)
//
// The run dir lives under .e2e-data/ (gitignored), NOT test-results/ —
// Playwright clears its outputDir at run start, which would race the
// webServer's DB file.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const E2E_DATA_ROOT = join(repoRoot, '.e2e-data');

/** One fresh, isolated state dir per suite invocation — hermetic per-run DB. */
export const RUN_DIR = join(E2E_DATA_ROOT, `run-${process.pid}`);

export const RUN_DB_PATH = join(RUN_DIR, 'companion.db');
export const RUN_UPLOADS_DIR = join(RUN_DIR, 'chat_uploads');

export const REPO_ROOT = repoRoot;
