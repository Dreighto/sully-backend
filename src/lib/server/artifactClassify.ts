import fs from 'node:fs';

export function ext(p: string): string {
	return p.split('.').pop()?.toLowerCase() ?? '';
}
export function basename(p: string): string {
	return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

// --- Thumbnail / preview helpers (artifact library tiles) --------------------
// Types whose first lines make a useful text tile in the library grid.
export const PREVIEW_TYPES = new Set(['doc', 'code', 'data', 'plan', 'log']);
// Extensions that can produce a real raster thumbnail (served via ?thumb=1).
const THUMB_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);
const LANG_BY_EXT: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	py: 'python',
	go: 'go',
	rs: 'rust',
	java: 'java',
	c: 'c',
	cpp: 'cpp',
	h: 'c',
	sh: 'bash',
	svelte: 'svelte',
	css: 'css',
	scss: 'scss',
	html: 'html',
	json: 'json',
	yaml: 'yaml',
	yml: 'yaml',
	sql: 'sql',
	md: 'markdown',
	swift: 'swift',
	rb: 'ruby',
	php: 'php'
};

export function previewFromText(content: string): string {
	return content.replace(/\r\n/g, '\n').slice(0, 400);
}
export function previewFromFile(filePath: string): string | null {
	try {
		return previewFromText(fs.readFileSync(filePath).subarray(0, 4096).toString('utf8'));
	} catch {
		return null;
	}
}
export function languageForExt(e: string): string | null {
	return LANG_BY_EXT[e.toLowerCase()] ?? null;
}
export function thumbUrlFor(artifactUrl: string, e: string): string | null {
	return THUMB_EXT.has(e.toLowerCase()) ? `${artifactUrl}?thumb=1` : null;
}

export const ARTIFACT_TYPE: Record<string, string> = {
	md: 'doc',
	txt: 'doc',
	rst: 'doc',
	pdf: 'doc',
	html: 'mockup',
	svg: 'mockup',
	png: 'screenshot',
	jpg: 'screenshot',
	jpeg: 'screenshot',
	webp: 'screenshot',
	ts: 'code',
	js: 'code',
	svelte: 'code',
	py: 'code',
	go: 'code',
	rs: 'code',
	sh: 'code',
	json: 'data',
	yaml: 'data',
	yml: 'data',
	csv: 'data',
	toml: 'data',
	zip: 'data',
	log: 'log',
	diff: 'log',
	patch: 'log'
};

export function classifyArtifactType(e: string): string {
	return ARTIFACT_TYPE[e.toLowerCase()] ?? 'other';
}
