// Pre-boot prep for the hermetic e2e webServer (LOS-182).
//
// This runs as the FIRST half of the webServer command, in the server's own
// shell, immediately before `node build/index.js` — the only spot that is
// provably ordered before the server's first request. It must NOT live in
// globalSetup: Playwright (verified on 1.60.0) starts the webServer BEFORE
// globalSetup runs, so a run-dir wipe there deletes the schema the server's
// bootstrap just created and the suite fails with
// `no such table: chat_user_state` (root-caused 2026-06-10 with a probe build:
// bootstrap logged "completed OK" against the run DB, THEN the globalSetup
// "hermetic run dir" line printed, THEN 100 no-such-table errors).
//
// Inputs come from the webServer env block in playwright.config.ts:
//   LOGUEOS_MEMORY_DB_PATH   — per-run DB path; RUN_DIR is its dirname
//   LOGUEOS_CHAT_UPLOADS_DIR — per-run uploads dir
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function fail(msg) {
	console.error(`[e2e-harness] ${msg}`);
	process.exit(1);
}

const dbPath = process.env.LOGUEOS_MEMORY_DB_PATH;
const uploadsDir = process.env.LOGUEOS_CHAT_UPLOADS_DIR;
if (!dbPath || !uploadsDir) {
	fail(
		'LOGUEOS_MEMORY_DB_PATH / LOGUEOS_CHAT_UPLOADS_DIR not set — prep-run-dir.mjs ' +
			'only runs as part of the playwright.config.ts webServer command.'
	);
}

const RUN_DIR = dirname(dbPath);
const E2E_DATA_ROOT = dirname(RUN_DIR);
const REPO_ROOT = process.cwd(); // webServer cwd is the repo root

// ── Precondition 1: the runtime env file exists. ───────────────────────────
// The server boots via `node --env-file=.env build/index.js`; without the env
// file it would come up in wired-kernel mode with no provider keys, and the
// chat-turn spec would fail minutes in with an opaque error instead of
// failing here with instructions.
if (!existsSync(join(REPO_ROOT, '.env'))) {
	fail(
		'.env not found at the repo root. The e2e webServer needs the companion ' +
			'runtime env (mode, provider keys). Copy it from the canonical checkout ' +
			'(~/dev/LogueOS-Companion/.env) — it is gitignored, never committed.'
	);
}

// ── Precondition 2: build/ exists and is not stale. ─────────────────────────
// The server serves the adapter-node build, not the source tree. A build/
// older than the newest src/ file means the suite would validate code that is
// no longer what's on the branch — a false-green generator (the same
// stale-chunk trap that bit the live service on 2026-06-10).
function newestMtimeMs(dir) {
	let newest = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) {
			newest = Math.max(newest, newestMtimeMs(p));
		} else if (entry.isFile()) {
			newest = Math.max(newest, statSync(p).mtimeMs);
		}
	}
	return newest;
}
const buildEntry = join(REPO_ROOT, 'build', 'index.js');
if (!existsSync(buildEntry)) {
	fail('build/index.js missing — run `npm run build` first.');
}
if (process.env.PLAYWRIGHT_SKIP_BUILD_CHECK !== '1') {
	if (newestMtimeMs(join(REPO_ROOT, 'src')) > statSync(buildEntry).mtimeMs) {
		fail(
			'build/ is older than src/ — run `npm run build` before the e2e suite so ' +
				'the tests exercise the current code. (Override with ' +
				'PLAYWRIGHT_SKIP_BUILD_CHECK=1 if you KNOW the src change is build-irrelevant.)'
		);
	}
}

// ── Per-run isolated state dir. ──────────────────────────────────────────────
// Safety guard before any recursive delete: only ever sweep inside a dir
// literally named .e2e-data. A mangled env var must not nuke anything else.
if (basename(E2E_DATA_ROOT) !== '.e2e-data') {
	fail(`refusing to sweep ${E2E_DATA_ROOT} — expected a dir named .e2e-data`);
}
// Sweep previous runs' dirs (best effort), then recreate the current run dir
// from scratch — THIS is the fresh-DB guarantee. The server's bootstrap
// (src/lib/server/bootstrap.ts) creates the schema on first boot against the
// empty path.
if (existsSync(E2E_DATA_ROOT)) {
	for (const entry of readdirSync(E2E_DATA_ROOT)) {
		const p = join(E2E_DATA_ROOT, entry);
		if (p !== RUN_DIR) {
			try {
				rmSync(p, { recursive: true, force: true });
			} catch {
				/* best effort — a dir held by a zombie server stays until next sweep */
			}
		}
	}
}
rmSync(RUN_DIR, { recursive: true, force: true });
mkdirSync(uploadsDir, { recursive: true });
console.log(`[e2e-harness] hermetic run dir: ${RUN_DIR}`);
