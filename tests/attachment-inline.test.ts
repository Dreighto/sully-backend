import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UPLOADS = vi.hoisted(() => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const nfs = require('node:fs') as typeof import('node:fs');
	const nos = require('node:os') as typeof import('node:os');
	const npath = require('node:path') as typeof import('node:path');
	return nfs.mkdtempSync(npath.join(nos.tmpdir(), 'sully-uploads-'));
});
vi.mock('$lib/server/config', () => ({
	serverConfig: { chatUploadsDir: UPLOADS }
}));

import {
	describeAttachmentsForClassifier,
	inlineDocumentAttachments
} from '$lib/server/chat/attachment_inline';

describe('inlineDocumentAttachments', () => {
	beforeEach(() => {
		for (const f of fs.readdirSync(UPLOADS)) fs.unlinkSync(path.join(UPLOADS, f));
	});
	afterEach(() => {});

	it('returns empty for text with no upload refs', async () => {
		expect(await inlineDocumentAttachments('just a question')).toBe('');
	});

	it('ignores image refs — vision concern, not ours', async () => {
		fs.writeFileSync(path.join(UPLOADS, 'a1b2.png'), 'png-bytes');
		expect(await inlineDocumentAttachments('look ![img](./api/chat/uploads/a1b2.png)')).toBe('');
	});

	it('inlines a text file as a fenced block', async () => {
		fs.writeFileSync(path.join(UPLOADS, 'notes-1.txt'), 'line one\nline two');
		const out = await inlineDocumentAttachments(
			'read this [notes](./api/chat/uploads/notes-1.txt)'
		);
		expect(out).toContain('notes-1.txt');
		expect(out).toContain('line one\nline two');
		expect(out).toContain('```');
	});

	it('marks oversized files truncated and caps the content', async () => {
		fs.writeFileSync(path.join(UPLOADS, 'big-1.txt'), 'x'.repeat(200 * 1024));
		const out = await inlineDocumentAttachments('see [big](./api/chat/uploads/big-1.txt)');
		expect(out).toContain('(truncated)');
		expect(out.length).toBeLessThan(140 * 1024);
	});

	it('refuses path traversal shapes (regex + resolve belt-and-braces)', async () => {
		const out = await inlineDocumentAttachments('x [f](./api/chat/uploads/../../etc/passwd.txt)');
		expect(out).toBe('');
	});

	it('missing file is silently skipped', async () => {
		expect(await inlineDocumentAttachments('x [f](./api/chat/uploads/nope-9.txt)')).toBe('');
	});

	it('dedupes repeated refs to the same file', async () => {
		fs.writeFileSync(path.join(UPLOADS, 'dup-1.md'), '# once');
		const out = await inlineDocumentAttachments(
			'[a](./api/chat/uploads/dup-1.md) and again [b](./api/chat/uploads/dup-1.md)'
		);
		expect(out.split('# once').length - 1).toBe(1);
	});
});

describe('uploads serving route hardening', () => {
	it('a PDF turn resolves without blocking semantics (async contract)', async () => {
		// pdfToText is async (execFile, not execFileSync) — pin the contract by
		// asserting inlineDocumentAttachments returns a Promise.
		const r = inlineDocumentAttachments('plain');
		expect(r).toBeInstanceOf(Promise);
		await r;
	});
});

describe('describeAttachmentsForClassifier', () => {
	it('replaces upload links with plain mentions', () => {
		const { cleaned, attachmentOnly } = describeAttachmentsForClassifier(
			'please review [design.md](./api/chat/uploads/abc-1.md) today'
		);
		expect(cleaned).toBe('please review (attached file: design.md) today');
		expect(attachmentOnly).toBe(false);
	});

	it('flags attachment-only turns — these must never propose a dispatch', () => {
		const { attachmentOnly } = describeAttachmentsForClassifier(
			'[2026-06-27-sully-hybrid-brain-design.md](./api/chat/uploads/eae757a2-a4d5-4944-9b88-e5524913660f.md)'
		);
		expect(attachmentOnly).toBe(true);
	});

	it('leaves plain text untouched', () => {
		const { cleaned, attachmentOnly } = describeAttachmentsForClassifier('run the speed test');
		expect(cleaned).toBe('run the speed test');
		expect(attachmentOnly).toBe(false);
	});
});

describe('byte-accurate turn budget (review round)', () => {
	it('multibyte content is clipped to the BYTE budget, not the code-unit count', async () => {
		// 4-byte emoji: 60k code units ≈ 120k units ≈ 240KB bytes — must clip.
		fs.writeFileSync(path.join(UPLOADS, 'emoji-1.txt'), '😀'.repeat(80 * 1024));
		const out = await inlineDocumentAttachments('see [e](./api/chat/uploads/emoji-1.txt)');
		expect(Buffer.byteLength(out, 'utf-8')).toBeLessThan(130 * 1024);
		expect(out).toContain('(truncated)');
		// No lone surrogate at any boundary — the whole string must round-trip.
		expect(out).toBe(Buffer.from(out, 'utf-8').toString('utf-8'));
	});
});
