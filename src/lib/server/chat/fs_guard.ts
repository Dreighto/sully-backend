// Filesystem security policy for the companion's read_file / list_directory
// tools — the PRIVATE-DATA leg of the lethal-trifecta defense.
//
// read_file/list_directory are root-confined to the operator's home, resolve
// symlinks BEFORE checking (the EscapeRoute CVE class), and hard-deny a secret
// list (.env, ~/.ssh, ~/.claude, kernel secrets + audit logs, card_catalog.db,
// *.pem/*.key, oauth creds). Read-only, size-capped, binary-rejected.
//
// Exports the home-root resolution, `resolveSafe` (path containment),
// `denyReason`, and the read caps the two tools enforce. The tool definitions
// themselves live in companion_tools.ts and source these helpers.

import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
// The operator chose "whole home folder" as the read root; overridable via env.
const FS_ROOT = path.resolve(process.env.COMPANION_FS_READ_ROOT || HOME);

export const MAX_FILE_BYTES = 256 * 1024; // per-read cap
export const MAX_DIR_ENTRIES = 300;

/** The active read root. Exported for the diagnostics/tests re-export. */
export const FS_READ_ROOT = FS_ROOT;

// ── Secret deny-list ────────────────────────────────────────────────────────
// Checked against the REAL (symlink-resolved) absolute path. Defense-in-depth:
// even inside the allowed root, these never get read or listed.
const DENY_BASENAMES = new Set([
	'id_rsa',
	'id_dsa',
	'id_ecdsa',
	'id_ed25519',
	'api-keys.env',
	'card_catalog.db',
	'.netrc',
	'.git-credentials',
	'credentials'
]);
const DENY_DIR_SEGMENTS = new Set([
	'.ssh',
	'.claude',
	'.gnupg',
	'.aws',
	'.gemini',
	'.config/gcloud'
]);
const DENY_SUFFIXES = ['.pem', '.key', '.kdbx', '.p12', '.pfx'];

// Absolute path prefixes that are off-limits wholesale (kernel secrets + audit
// logs, project-miru card DB, migration mount).
const DENY_PREFIXES = [
	path.join(HOME, '.ssh'),
	path.join(HOME, '.claude'),
	path.join(HOME, '.gnupg'),
	path.join(HOME, '.aws'),
	path.join(HOME, '.gemini'),
	'/home/dreighto/dev/LogueOS-Orchestrator/.env',
	'/home/dreighto/dev/LogueOS-Orchestrator/data',
	'/home/dreighto/dev/miru/data/card_catalog.db',
	'/mnt/migration'
];

/** Returns a denial reason string if `real` (a resolved absolute path) is protected, else null. */
export function denyReason(real: string): string | null {
	const base = path.basename(real);
	if (base === '.env' || base.startsWith('.env.')) return 'environment / secrets file';
	if (DENY_BASENAMES.has(base)) return 'protected credential/data file';
	if (base.includes('oauth') && base.includes('cred')) return 'oauth credential file';
	if (base.includes('secret') || base.includes('credential')) return 'secret-named file';
	if (DENY_SUFFIXES.some((s) => base.toLowerCase().endsWith(s))) return 'key/certificate file';
	const segs = real.split(path.sep);
	if (segs.some((s) => DENY_DIR_SEGMENTS.has(s))) return 'protected directory';
	if (base === 'card_catalog.db') return 'project-miru protected database';
	if (
		real.includes('/LogueOS-Orchestrator/data/') &&
		(real.endsWith('.jsonl') || real.endsWith('.db'))
	)
		return 'kernel audit log / database';
	if (real.startsWith('/home/dreighto/dev/LogueOS-Companion/data/') && real.endsWith('.db'))
		return 'companion database';
	for (const p of DENY_PREFIXES) {
		if (real === p || real.startsWith(p + path.sep)) return 'protected path';
	}
	return null;
}

type SafeResult = { ok: true; real: string } | { ok: false; error: string };

/**
 * Resolve a requested path safely: expand ~, make absolute, resolve symlinks
 * (so a symlink inside the root can't point out of it — the EscapeRoute CVE
 * class), confine to FS_ROOT, then apply the secret deny-list.
 */
export function resolveSafe(input: string): SafeResult {
	if (!input || typeof input !== 'string') return { ok: false, error: 'no path given' };
	let abs = input.trim();
	if (abs.startsWith('~')) abs = path.join(HOME, abs.slice(1).replace(/^[/\\]/, ''));
	abs = path.resolve(FS_ROOT, abs); // absolute input stays; relative resolves under root

	let real: string;
	try {
		real = realpathSync(abs);
	} catch {
		// Path may not exist yet (rare for a read tool) — resolve the nearest
		// existing ancestor and re-attach the tail, so we still check the REAL
		// location rather than a string prefix.
		try {
			const parentReal = realpathSync(path.dirname(abs));
			real = path.join(parentReal, path.basename(abs));
		} catch {
			return { ok: false, error: 'path does not exist' };
		}
	}

	const rootReal = realpathSync(FS_ROOT);
	if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
		return { ok: false, error: 'path is outside the allowed area' };
	}
	const denied = denyReason(real);
	if (denied) return { ok: false, error: `blocked: ${denied}` };
	return { ok: true, real };
}
