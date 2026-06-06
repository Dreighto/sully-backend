// Phase 5b — security boundary for the artifact preview/download endpoint.
// The endpoint serves worker-built files, so path confinement is load-bearing.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

// A throwaway workspace root; set BEFORE importing workspace.ts (WORKSPACE_ROOT
// is a module-load const reading SULLY_WORKSPACE_ROOT).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sully-ws-test-'));
process.env.SULLY_WORKSPACE_ROOT = ROOT;

const projectDir = path.join(ROOT, 'demo');
fs.mkdirSync(path.join(projectDir, 'sub'), { recursive: true });
fs.writeFileSync(path.join(projectDir, 'index.html'), '<h1>hi</h1>');
fs.writeFileSync(path.join(projectDir, 'sub', 'app.js'), 'console.log(1)');

// A file OUTSIDE the sandbox + a symlink to it inside the project (the symlink
// passes string-confinement but must be caught by the realpath check).
const outside = path.join(os.tmpdir(), `sully-outside-${process.pid}.txt`);
fs.writeFileSync(outside, 'secret');
let symlinkMade = true;
try {
	fs.symlinkSync(outside, path.join(projectDir, 'evil'));
} catch {
	symlinkMade = false; // some CI sandboxes disallow symlinks
}

const ws = await import('$lib/server/workspace');

describe('5b — workspace file confinement', () => {
	it('resolves a valid nested file to its absolute path', () => {
		expect(ws.resolveWorkspaceFile('demo', 'sub/app.js')).toBe(
			path.join(projectDir, 'sub', 'app.js')
		);
	});

	it('rejects parent traversal', () => {
		expect(() => ws.resolveWorkspaceFile('demo', '../../etc/passwd')).toThrow();
	});

	it('rejects absolute paths', () => {
		expect(() => ws.resolveWorkspaceFile('demo', '/etc/passwd')).toThrow();
	});

	it('rejects null bytes', () => {
		expect(() => ws.resolveWorkspaceFile('demo', 'a\0b')).toThrow();
	});

	it('rejects an empty/invalid project slug', () => {
		expect(() => ws.resolveWorkspaceFile('', 'index.html')).toThrow();
		expect(() => ws.resolveWorkspaceFile('..', 'index.html')).toThrow();
	});

	it('confines to the project dir — cannot escape into a sibling project', () => {
		expect(() => ws.resolveWorkspaceFile('demo', '../other/secret')).toThrow();
	});

	it('assertWorkspaceReal accepts a real in-sandbox file', async () => {
		const p = ws.resolveWorkspaceFile('demo', 'index.html');
		await expect(ws.assertWorkspaceReal(p)).resolves.toBe(fs.realpathSync(p));
	});

	it.skipIf(!symlinkMade)(
		'assertWorkspaceReal rejects a symlink escaping the sandbox',
		async () => {
			// string-confinement passes (the link path is inside demo)…
			const p = ws.resolveWorkspaceFile('demo', 'evil');
			// …but realpath resolves outside the sandbox → rejected.
			await expect(ws.assertWorkspaceReal(p)).rejects.toThrow();
		}
	);
});
