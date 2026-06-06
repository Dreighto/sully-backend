// Phase 5 / 5a — Sully's artifact workspace service.
//
// SECURITY-CONFINED, deterministic file ops for the sandboxed git repo at
// WORKSPACE_ROOT. The model never authors arbitrary content here: the server
// creates per-project folders, copies operator-provided reference files in, and
// commits — so a dispatched worker (which builds in a worktree of this repo)
// finds the references already present. Every path is confined to WORKSPACE_ROOT.
//
// Confinement is two-layered: confineResolve() string-resolves a candidate and
// rejects any escape (works for not-yet-existing paths — the common case); and
// assertRealWithin() fs.realpath()s an EXISTING path + re-checks, to defeat a
// symlink that points outside the workspace. New paths are string-confined, then
// realpath-checked once they exist.
//
// (Draft generated via the operator's Ollama Cloud key (deepseek-v3.1) then
// hardened here: the original realpath'd non-existent paths — breaking creation
// and the symlink defense — and parsed the branch name as the commit SHA.)

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serverConfig } from '$lib/server/config';

const execFileAsync = promisify(execFile);

// Default to the real workspace; overridable for tests (so confinement can be
// exercised against a temp dir without touching the real repo).
export const WORKSPACE_ROOT =
	process.env.SULLY_WORKSPACE_ROOT || '/home/dreighto/dev/sully-workspace';

/** Filesystem-safe project slug: lowercase, [a-z0-9-], collapsed/trimmed hyphens. */
export function slugify(name: string): string {
	const slug = (name || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (!slug) throw new Error('empty project slug');
	return slug;
}

/**
 * Best-effort project slug from a task brief. Prefers a named project
 * ("todays-ops project", "the ops dashboard"); falls back to 'artifact'.
 */
export function deriveProject(task: string): string {
	const m = (task || '').match(
		/\b([a-z0-9][a-z0-9_-]{1,40})\s+(?:project|dashboard|workspace|app|site|page|mockup)\b/i
	);
	try {
		return m ? slugify(m[1]) : 'artifact';
	} catch {
		return 'artifact';
	}
}

/** String-confine: resolve candidate under base; reject escape. Safe for non-existent paths. */
function confineResolve(base: string, ...parts: string[]): string {
	for (const p of parts) if (p.includes('\0')) throw new Error('null byte in path');
	const resolved = path.resolve(base, ...parts);
	if (resolved !== base && !resolved.startsWith(base + path.sep)) {
		throw new Error('path escapes workspace boundary');
	}
	return resolved;
}

/** Realpath-confine an EXISTING path (defeats symlinks). Throws if missing or escaping. */
async function assertRealWithin(base: string, target: string): Promise<string> {
	const realBase = await fs.realpath(base);
	const real = await fs.realpath(target);
	if (real !== realBase && !real.startsWith(realBase + path.sep)) {
		throw new Error('symlink escapes workspace boundary');
	}
	return real;
}

/** Create `<root>/<slug>/` + `<slug>/refs/` (idempotent). Returns the absolute project dir. */
export async function ensureProject(project: string): Promise<{ dir: string }> {
	const slug = slugify(project);
	const dir = confineResolve(WORKSPACE_ROOT, slug);
	await fs.mkdir(path.join(dir, 'refs'), { recursive: true });
	await assertRealWithin(WORKSPACE_ROOT, dir); // re-check now that it exists
	return { dir };
}

/**
 * Copy a reference file (an existing upload within serverConfig.chatUploadsDir)
 * into `<project>/refs/<basename>`. Rejects traversal/absolute names + sources
 * outside the uploads dir.
 */
export async function placeReference(
	project: string,
	srcPath: string,
	name: string
): Promise<{ path: string }> {
	if (name.includes('\0') || name.includes('..') || path.isAbsolute(name)) {
		throw new Error('invalid reference name');
	}
	const safeName = path.basename(name);
	if (!safeName || safeName === '.' || safeName === '..') throw new Error('invalid reference name');

	// Source must be a real file within the uploads dir.
	const uploadsReal = await fs.realpath(serverConfig.chatUploadsDir);
	const srcReal = await fs.realpath(path.resolve(serverConfig.chatUploadsDir, srcPath));
	if (srcReal !== uploadsReal && !srcReal.startsWith(uploadsReal + path.sep)) {
		throw new Error('reference source is outside the uploads dir');
	}

	const { dir } = await ensureProject(project);
	const refsDir = confineResolve(dir, 'refs');
	await assertRealWithin(WORKSPACE_ROOT, refsDir); // refs/ exists (ensureProject made it)
	const dest = confineResolve(refsDir, safeName);
	await fs.copyFile(srcReal, dest);
	return { path: dest };
}

/**
 * `git add -A` + commit in WORKSPACE_ROOT. Returns the new short SHA, or null if
 * there was nothing to commit. argv-only (no shell) — no command injection.
 */
export async function commitWorkspace(message: string): Promise<{ sha: string | null }> {
	await execFileAsync('git', ['-C', WORKSPACE_ROOT, 'add', '-A']);
	const status = await execFileAsync('git', ['-C', WORKSPACE_ROOT, 'status', '--porcelain']);
	if (!status.stdout.trim()) return { sha: null };
	await execFileAsync('git', [
		'-C',
		WORKSPACE_ROOT,
		'-c',
		'user.name=Sully',
		'-c',
		'user.email=sully@logueos.local',
		'commit',
		'-m',
		message
	]);
	const sha = (
		await execFileAsync('git', ['-C', WORKSPACE_ROOT, 'rev-parse', '--short', 'HEAD'])
	).stdout.trim();
	return { sha: sha || null };
}

// ── 5b: confined read access for the artifact preview/download endpoint ──────────
//
// The preview endpoint serves files a worker built inside the workspace. The
// security-critical piece is the SAME two-layer confinement the write side uses:
// string-confine to <root>/<project> (rejects traversal/absolute/UNC/null —
// works for the not-yet-realpath'd request), then realpath-confine the existing
// target (defeats a worker-created symlink that points outside the sandbox).

/**
 * Resolve a request for `<project>/<relPath>` to a confined absolute path under
 * `<WORKSPACE_ROOT>/<project>`, WITHOUT requiring the file to exist (string
 * confinement only). Throws on a bad project slug, traversal, absolute/UNC
 * paths, or null bytes. The caller MUST still `stat()` for existence and call
 * `assertWorkspaceReal()` before serving the bytes (symlink defense).
 */
export function resolveWorkspaceFile(project: string, relPath: string): string {
	const slug = slugify(project); // validates: lowercase [a-z0-9-], non-empty
	const projectDir = confineResolve(WORKSPACE_ROOT, slug);
	if (!relPath || !relPath.trim()) throw new Error('empty file path');
	return confineResolve(projectDir, relPath);
}

/** Realpath-confine an EXISTING resolved path to WORKSPACE_ROOT (defeats symlinks). */
export async function assertWorkspaceReal(target: string): Promise<string> {
	return assertRealWithin(WORKSPACE_ROOT, target);
}
