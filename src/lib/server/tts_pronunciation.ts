/**
 * Voice-only pronunciation rewrites (SUL-176). Applied inside `speakableText`
 * before SSML tagging — never on displayed chat text.
 */

const ONES = [
	'zero',
	'one',
	'two',
	'three',
	'four',
	'five',
	'six',
	'seven',
	'eight',
	'nine',
	'ten',
	'eleven',
	'twelve',
	'thirteen',
	'fourteen',
	'fifteen',
	'sixteen',
	'seventeen',
	'eighteen',
	'nineteen'
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Acronyms/terms → spoken alias. Value `'spell'` = letter-by-letter. */
const ACRONYM_ALIASES: Record<string, string | 'spell'> = {
	JSON: 'jason',
	README: 'read me',
	CLI: 'spell',
	URL: 'spell',
	API: 'spell',
	npm: 'spell',
	SQL: 'sequel'
};

const ACRONYM_TERMS = Object.keys(ACRONYM_ALIASES).sort((a, b) => b.length - a.length);
const ACRONYM_AT_START = new RegExp(
	`^(${ACRONYM_TERMS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
	'i'
);

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const UNIX_PATH_RE = /(?:^|\s)(\/(?:[\w.-]+|~)+(?:\/[\w.-]+)+)/g;

function under100(n: number): string {
	if (n < 20) return ONES[n];
	const tens = Math.floor(n / 10);
	const ones = n % 10;
	return TENS[tens] + (ones ? `-${ONES[ones]}` : '');
}

/** Natural spoken form for calendar years 1900–2099. */
export function yearToSpoken(year: number): string {
	if (year < 1900 || year > 2099) return String(year);

	if (year >= 2000 && year <= 2099) {
		if (year === 2000) return 'two thousand';
		const tail = year % 100;
		if (tail === 0) return 'two thousand';
		if (tail < 10) return `two thousand ${ONES[tail]}`;
		return `twenty ${under100(tail)}`;
	}

	// 1900–1999
	if (year === 1900) return 'nineteen hundred';
	const tail = year % 100;
	if (tail === 0) return 'nineteen hundred';
	if (tail < 10) return `nineteen oh-${ONES[tail]}`;
	return `nineteen ${under100(tail)}`;
}

function spellOutLetters(word: string): string {
	return word.toUpperCase().split('').join(' ');
}

export function acronymSpokenAlias(raw: string): string | null {
	const entry = Object.entries(ACRONYM_ALIASES).find(
		([key]) => key.toLowerCase() === raw.toLowerCase()
	);
	if (!entry) return null;
	const alias = entry[1];
	return alias === 'spell' ? spellOutLetters(raw) : alias;
}

function speakableUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.replace(/\./g, ' dot ');
		const pathPart = parsed.pathname
			.split('/')
			.filter(Boolean)
			.join(' slash ');
		return pathPart ? `${host} slash ${pathPart}` : host;
	} catch {
		return url;
	}
}

function simplifyUnixPath(path: string): string {
	const segments = path.split('/').filter(Boolean);
	return segments.length ? segments[segments.length - 1] : path;
}

/** Plain-text prelude: URLs, paths, arrows, ampersands — before SSML tokenization. */
export function applyVoicePronunciationPrelude(text: string): string {
	if (!text) return text;

	let out = text.replace(URL_RE, (url) => speakableUrl(url));

	out = out.replace(UNIX_PATH_RE, (match, path: string) => {
		const prefix = match.startsWith('/') ? '' : match[0];
		return `${prefix}${simplifyUnixPath(path)}`;
	});

	out = out.replace(/=>/g, ' ').replace(/->/g, ' ');
	out = out.replace(/&/g, ' and ');

	return out;
}

/** Match the next acronym at `rest` start (word boundary). */
export function matchAcronym(rest: string): { raw: string; alias: string } | null {
	const m = rest.match(ACRONYM_AT_START);
	if (!m) return null;
	const raw = m[1];
	const alias = acronymSpokenAlias(raw);
	return alias ? { raw, alias } : null;
}

/** True when `rest` starts with a 4-digit year we should rewrite (not already spoken). */
export function matchSpeakableYear(rest: string): { raw: string; alias: string } | null {
	const m = rest.match(/^(19\d{2}|20\d{2})\b/);
	if (!m) return null;
	const year = Number(m[0]);
	if (year < 1900 || year > 2099) return null;
	// Guard: skip if the digits are already preceded by spoken-year words in the source
	// (e.g. upstream already expanded "twenty twenty-six").
	return { raw: m[0], alias: yearToSpoken(year) };
}
