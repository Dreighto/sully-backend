import {
	applyVoicePronunciationPrelude,
	matchAcronym,
	matchSpeakableYear
} from './tts_pronunciation';
import { rewriteForSpeech } from './voice_rewrite';

const MONTHS =
	'January|February|March|April|May|June|July|August|September|October|November|December';

const MONTH_DAY_RE = new RegExp(`^(${MONTHS})\\s+(\\d{1,2})\\b`);
const UNIT_WORD: Record<string, string> = {
	gb: 'gigabytes',
	mb: 'megabytes',
	tb: 'terabytes',
	kb: 'kilobytes',
	ghz: 'gigahertz',
	mhz: 'megahertz'
};
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

function escapeXml(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(text: string): string {
	return escapeXml(text).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function under100(n: number): string {
	if (n < 20) return ONES[n];
	const tens = Math.floor(n / 10);
	const ones = n % 10;
	return TENS[tens] + (ones ? `-${ONES[ones]}` : '');
}

function intToWords(n: number): string {
	if (n < 20) return ONES[n];
	if (n < 100) return under100(n);
	if (n < 1000) {
		const hundreds = Math.floor(n / 100);
		const rest = n % 100;
		return `${ONES[hundreds]} hundred${rest ? ` ${under100(rest)}` : ''}`;
	}
	if (n < 1_000_000) {
		const thousands = Math.floor(n / 1000);
		const rest = n % 1000;
		return `${intToWords(thousands)} thousand${rest ? ` ${intToWords(rest)}` : ''}`;
	}
	return String(n);
}

function numberAlias(text: string): string {
	if (!text.includes('.')) return intToWords(Number(text));
	const [whole, fraction] = text.split('.');
	return `${intToWords(Number(whole))} point ${fraction
		.split('')
		.map((digit) => ONES[Number(digit)])
		.join(' ')}`;
}

function currencySsml(amount: string): string {
	const normalized = amount.replaceAll(',', '').replaceAll(/\s+/g, '');
	return `<say-as interpret-as="currency" language="en-US">${escapeXml(normalized)} USD</say-as>`;
}

function subTag(raw: string, alias: string): string {
	return `<sub alias="${escapeAttr(alias)}">${escapeXml(raw)}</sub>`;
}

function sayAs(attrs: string, content: string): string {
	return `<say-as ${attrs}>${escapeXml(content)}</say-as>`;
}

export function speakableText(text: string): string {
	const normalized = applyVoicePronunciationPrelude(text.replace(/[‐‑‒–—]/g, '-'));
	let out = '';
	let index = 0;

	while (index < normalized.length) {
		const rest = normalized.slice(index);

		const acronym = matchAcronym(rest);
		if (acronym) {
			out += subTag(acronym.raw, acronym.alias);
			index += acronym.raw.length;
			continue;
		}

		const currencyRange = rest.match(
			/^\$\s*(\d[\d,]*(?:\.\d{1,2})?)\s*-\s*\$\s*(\d[\d,]*(?:\.\d{1,2})?)\b/
		);
		if (currencyRange) {
			out += `${currencySsml(currencyRange[1])} to ${currencySsml(currencyRange[2])}`;
			index += currencyRange[0].length;
			continue;
		}

		const currency = rest.match(/^\$\s*(\d[\d,]*)(?:\.(\d{1,2}))?\b/);
		if (currency) {
			const amount = currency[2] ? `${currency[1]}.${currency[2]}` : currency[1];
			out += currencySsml(amount);
			index += currency[0].length;
			continue;
		}

		const unit = rest.match(/^(\d+(?:\.\d+)?)\s*(GB|MB|TB|KB|GHz|MHz)\b/i);
		if (unit) {
			const alias = `${numberAlias(unit[1])} ${UNIT_WORD[unit[2].toLowerCase()] ?? unit[2]}`;
			out += subTag(unit[0], alias);
			index += unit[0].length;
			continue;
		}

		const time = rest.match(/^(\d{1,2}):(\d{2})\b/);
		if (time) {
			out += sayAs('interpret-as="time" format="hms12"', time[0]);
			index += time[0].length;
			continue;
		}

		const monthDay = rest.match(MONTH_DAY_RE);
		if (monthDay) {
			out += sayAs('interpret-as="date" format="md"', monthDay[0]);
			index += monthDay[0].length;
			continue;
		}

		const ordinal = rest.match(/^(\d+)(st|nd|rd|th)\b/i);
		if (ordinal) {
			out += sayAs('interpret-as="ordinal"', ordinal[1]);
			index += ordinal[0].length;
			continue;
		}

		const percent = rest.match(/^(\d+(?:\.\d+)?)%/);
		if (percent) {
			const alias = `${numberAlias(percent[1])} percent`;
			out += subTag(percent[0], alias);
			index += percent[0].length;
			continue;
		}

		const year = matchSpeakableYear(rest);
		if (year) {
			out += subTag(year.raw, year.alias);
			index += year.raw.length;
			continue;
		}

		out += escapeXml(normalized[index]);
		index += 1;
	}

	return out;
}

// SPOKEN-output entry point (SUL-194 / W4-A). Runs the optional contextual
// pronunciation rewriter (dark by default via VOICE_REWRITER_MODEL) and then
// the deterministic SSML normalizer, which is the trusted base. Display text
// must keep calling speakableText directly; the rewriter is voice-only. Any
// rewrite failure or timeout is swallowed inside rewriteForSpeech, so with the
// flag off this is byte-identical to speakableText(text).
export async function speakableTextForSpeech(
	text: string,
	opts?: { signal?: AbortSignal }
): Promise<string> {
	return speakableText(await rewriteForSpeech(text, opts));
}
