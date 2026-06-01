// Shared exfiltration guard: refuse tool args that carry secret-shaped strings.
// Used by the web tools (web_search/web_fetch) AND the consult tools
// (deep_think/consult_claude) — both ship operator-supplied text to an external
// backend, so both must scan it. The filesystem tools (read_file/list_directory)
// do NOT use this; they guard reads via the deny-list in fs_guard instead. Kept
// in its own tiny module so web_search.ts and consult.ts share one copy.

const SECRET_PATTERNS: RegExp[] = [
	/sk-[a-zA-Z0-9]{16,}/, // OpenAI-style
	/AKIA[0-9A-Z]{12,}/, // AWS access key
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM
	/gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub token
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
	/[a-f0-9]{64,}/, // long hex (key-ish)
	/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./ // JWT
];

export function carriesSecret(s: string): boolean {
	return SECRET_PATTERNS.some((re) => re.test(s));
}
