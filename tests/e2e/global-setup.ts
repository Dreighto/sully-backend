// Global setup for the hermetic e2e harness (LOS-182).
//
// Runs in Playwright's main process BEFORE the webServer is launched, so this
// is where the per-run isolated state dir is prepared and the fail-fast
// preconditions are checked. See tests/e2e/README.md for the full contract.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_DATA_ROOT, REPO_ROOT, RUN_DIR, RUN_UPLOADS_DIR } from './harness-paths';

/** Newest mtime (ms) of any file under dir, recursively. */
function newestMtimeMs(dir: string): number {
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

export default function globalSetup(): void {
	// External-server mode (PLAYWRIGHT_BASE_URL set): the operator is pointing
	// the suite at a server THEY manage — no webServer is spawned, so no run
	// dir, no .env requirement, no build check. Non-hermetic by definition;
	// the empty-state trio is only trustworthy against a clean profile.
	if (process.env.PLAYWRIGHT_BASE_URL) {
		console.log(
			`[e2e-harness] external server mode: ${process.env.PLAYWRIGHT_BASE_URL} ` +
				'(no hermetic DB — empty-state specs assume the target has a clean profile)'
		);
		return;
	}

	// ── Precondition 1: the runtime env file exists. ─────────────────────────
	// The webServer boots via `node --env-file=.env build/index.js`; without
	// the env file the server would come up in wired-kernel mode with no
	// provider keys, and the chat-turn spec would fail three minutes in with
	// an opaque error instead of failing here with instructions.
	if (!existsSync(join(REPO_ROOT, '.env'))) {
		throw new Error(
			'[e2e-harness] .env not found at the repo root. The e2e webServer needs the ' +
				'companion runtime env (mode, provider keys). Copy it from the canonical ' +
				'checkout (~/dev/LogueOS-Companion/.env) — it is gitignored, never committed.'
		);
	}

	// ── Precondition 2: build/ exists and is not stale. ──────────────────────
	// The webServer serves the adapter-node build, not the source tree. A
	// build/ older than the newest src/ file means the suite would validate
	// code that is no longer what's on the branch — a false-green generator
	// (and the same stale-chunk trap that bit the live service on 2026-06-10).
	const buildEntry = join(REPO_ROOT, 'build', 'index.js');
	if (!existsSync(buildEntry)) {
		throw new Error('[e2e-harness] build/index.js missing — run `npm run build` first.');
	}
	if (process.env.PLAYWRIGHT_SKIP_BUILD_CHECK !== '1') {
		const srcNewest = newestMtimeMs(join(REPO_ROOT, 'src'));
		const buildMtime = statSync(buildEntry).mtimeMs;
		if (srcNewest > buildMtime) {
			throw new Error(
				'[e2e-harness] build/ is older than src/ — run `npm run build` before the e2e ' +
					'suite so the tests exercise the current code. (Override with ' +
					'PLAYWRIGHT_SKIP_BUILD_CHECK=1 if you KNOW the src change is build-irrelevant.)'
			);
		}
	}

	// ── Per-run isolated state dir. ──────────────────────────────────────────
	// Sweep previous runs' dirs first (best effort — a dir held open by a
	// zombie server just stays until the next sweep). One suite invocation per
	// worktree at a time; the server port (5188) already enforces that.
	if (existsSync(E2E_DATA_ROOT)) {
		for (const entry of readdirSync(E2E_DATA_ROOT)) {
			const p = join(E2E_DATA_ROOT, entry);
			if (p !== RUN_DIR) {
				try {
					rmSync(p, { recursive: true, force: true });
				} catch {
					/* best effort */
				}
			}
		}
	}
	// Recreate the current run dir from scratch — THIS is the fresh-DB
	// guarantee. The server's bootstrap (src/lib/server/bootstrap.ts) creates
	// the schema on first boot against the empty path.
	rmSync(RUN_DIR, { recursive: true, force: true });
	mkdirSync(RUN_UPLOADS_DIR, { recursive: true });
	console.log(`[e2e-harness] hermetic run dir: ${RUN_DIR}`);
}
