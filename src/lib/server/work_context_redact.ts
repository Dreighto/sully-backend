// Secret redaction for work-context ingest chunks (SUL-178).
// Line-oriented: mask likely secrets; callers skip chunks that stay secret-dense.

const SECRET_LINE_PATTERNS: RegExp[] = [
	/sk-[a-zA-Z0-9]{16,}/g,
	/gh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	/AKIA[0-9A-Z]{12,}/g,
	/(?:HMAC|secret)\s*=\s*\S+/gi,
	/\b[a-f0-9]{32,}\b/gi
];

const REMAINING_SECRET_RE =
	/sk-[a-zA-Z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|AKIA[0-9A-Z]{12,}|(?:HMAC|secret)\s*=\s*\S+|\b[a-f0-9]{32,}\b/i;

function redactLine(line: string): string {
	let out = line;
	for (const re of SECRET_LINE_PATTERNS) {
		out = out.replace(re, '[redacted]');
	}
	return out;
}

/** Mask likely secret substrings line-by-line. */
export function redact(text: string): string {
	return text
		.split('\n')
		.map((line) => redactLine(line))
		.join('\n');
}

/** True when too many lines still look secret-bearing after redaction. */
export function isSecretDense(text: string): boolean {
	if (REMAINING_SECRET_RE.test(text)) return true;
	const lines = text.split('\n').filter((l) => l.trim());
	if (!lines.length) return false;
	let hits = 0;
	for (const line of lines) {
		if (REMAINING_SECRET_RE.test(line)) hits++;
	}
	return hits / lines.length > 0.15;
}
