// attachment_inline.ts — make document attachments readable by EVERY model.
//
// The client embeds uploads as markdown links in the message text
// ("![name](./api/chat/uploads/<uuid>.<ext>)" or "[name](…)"). Images are a
// vision concern; DOCUMENT attachments (txt/md/json/csv/pdf, W3 2026-07-07)
// are handled here: read the file from chatUploadsDir and append its content
// to the MODEL-FACING copy of the turn as fenced text. Works identically for
// anthropic / google / ollama-cloud / local — no provider file-part support
// required. The persisted operator message keeps only the link.
//
// PDFs go through `pdftotext -layout` (poppler-utils). Extraction failures
// degrade to an honest note — never a silent drop.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { serverConfig } from '$lib/server/config';

const UPLOAD_REF_RE =
	/\]\((?:\.\/)?(?:companion\/)?api\/chat\/uploads\/([A-Za-z0-9-]+\.[A-Za-z0-9]+)\)/g;
const TEXT_EXTS = new Set(['txt', 'md', 'json', 'csv', 'log']);
const PDF_EXT = 'pdf';

// Per-file and per-turn caps: enough for real docs, small enough to never
// blow the context window on a phone-uploaded dump.
const MAX_INLINE_BYTES_PER_FILE = 120 * 1024;
const MAX_INLINE_BYTES_PER_TURN = 240 * 1024;

function safeUploadPath(filename: string): string | null {
	const resolved = path.resolve(serverConfig.chatUploadsDir, filename);
	const root = path.resolve(serverConfig.chatUploadsDir);
	if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
	return resolved;
}

function readTextCapped(p: string): { text: string; truncated: boolean } {
	const buf = fs.readFileSync(p);
	const truncated = buf.length > MAX_INLINE_BYTES_PER_FILE;
	return {
		text: buf.subarray(0, MAX_INLINE_BYTES_PER_FILE).toString('utf-8'),
		truncated
	};
}

const execFileAsync = promisify(execFile);

async function pdfToText(p: string): Promise<{ text: string; truncated: boolean } | null> {
	try {
		// ASYNC on purpose: a slow/hostile PDF must only stall its own turn,
		// never the event loop (execFileSync here would freeze the whole
		// process for up to the timeout — in-house review finding, 2026-07-07).
		const { stdout } = await execFileAsync('pdftotext', ['-layout', '-q', p, '-'], {
			timeout: 15_000,
			maxBuffer: MAX_INLINE_BYTES_PER_FILE * 2
		});
		const out = stdout.toString();
		const truncated = out.length > MAX_INLINE_BYTES_PER_FILE;
		return { text: out.slice(0, MAX_INLINE_BYTES_PER_FILE), truncated };
	} catch {
		return null;
	}
}

/**
 * Scan a user turn for document-attachment references and return the fenced
 * content block to append to the model-facing message (empty string when the
 * turn has no readable documents). Never throws.
 */
export async function inlineDocumentAttachments(userText: string): Promise<string> {
	let budget = MAX_INLINE_BYTES_PER_TURN;
	const sections: string[] = [];
	const seen = new Set<string>();
	for (const m of userText.matchAll(UPLOAD_REF_RE)) {
		const filename = m[1];
		if (seen.has(filename)) continue;
		seen.add(filename);
		const ext = filename.split('.').pop()?.toLowerCase() ?? '';
		if (!TEXT_EXTS.has(ext) && ext !== PDF_EXT) continue; // images etc. — not ours
		const p = safeUploadPath(filename);
		if (!p || !fs.existsSync(p)) continue;
		try {
			const extracted = ext === PDF_EXT ? await pdfToText(p) : readTextCapped(p);
			if (!extracted || !extracted.text.trim()) {
				sections.push(`[Attached file ${filename} could not be read as text.]`);
				continue;
			}
			// Budget in BYTES, not UTF-16 units — multibyte documents could
			// otherwise overshoot the turn budget ~2x (DPSK verification #1).
			let clipped = extracted.text;
			while (Buffer.byteLength(clipped, 'utf-8') > budget) {
				clipped = clipped.slice(0, Math.floor(clipped.length * 0.9));
			}
			// Never end on a split surrogate pair (the 0.9 cut is code-unit
			// based) — a lone high surrogate serializes as U+FFFD mojibake.
			const lastUnit = clipped.charCodeAt(clipped.length - 1);
			if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
				clipped = clipped.slice(0, -1);
			}
			// Budget exhausted to nothing: an empty fenced block is pure
			// prompt noise — skip this file entirely.
			if (clipped.trim().length === 0) break;
			budget -= Buffer.byteLength(clipped, 'utf-8');
			sections.push(
				`Attached file \`${filename}\`${extracted.truncated || clipped.length < extracted.text.length ? ' (truncated)' : ''}:\n\`\`\`\n${clipped}\n\`\`\``
			);
			if (budget <= 0) break;
		} catch {
			sections.push(`[Attached file ${filename} could not be read.]`);
		}
	}
	return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';
}

/**
 * Replace upload-link markdown with a plain-English mention and report
 * whether anything else remains. The dispatch classifier must never read a
 * raw "[file.md](./api/chat/uploads/…)" as a work brief — on 2026-07-07 an
 * attachment-only turn produced a dispatch proposal quoting the link.
 */
export function describeAttachmentsForClassifier(userText: string): {
	cleaned: string;
	attachmentOnly: boolean;
} {
	let sawRef = false;
	const cleaned = userText
		.replace(
			/!?\[([^\]]*)\]\((?:\.\/)?(?:companion\/)?api\/chat\/uploads\/[A-Za-z0-9-]+\.[A-Za-z0-9]+\)/g,
			(_m, name) => {
				sawRef = true;
				return `(attached file: ${name || 'file'})`;
			}
		)
		.trim();
	const withoutMentions = cleaned.replace(/\(attached file: [^)]*\)/g, '').trim();
	return { cleaned, attachmentOnly: sawRef && withoutMentions.length === 0 };
}
