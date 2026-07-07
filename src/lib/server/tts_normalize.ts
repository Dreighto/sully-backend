// Spoken-text normalization for TTS. The speech engine reads raw digits as
// cardinal numbers — "5:02 PM" becomes "five thousand two", "2026" becomes an
// odd mash. This converts digit-y text into the words a person would actually
// say, so the synthesized voice sounds natural. Applied server-side to every
// sentence before it's sent to the TTS service (speak + speak-local routes).

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
const MONTHS =
	'January|February|March|April|May|June|July|August|September|October|November|December';

function under100(n: number): string {
	if (n < 20) return ONES[n];
	const t = Math.floor(n / 10);
	const o = n % 10;
	return TENS[t] + (o ? '-' + ONES[o] : '');
}

function under1000(n: number): string {
	if (n < 100) return under100(n);
	const h = Math.floor(n / 100);
	const r = n % 100;
	return ONES[h] + ' hundred' + (r ? ' ' + under100(r) : '');
}

function intToWords(n: number): string {
	if (n === 0) return 'zero';
	if (n < 0) return 'minus ' + intToWords(-n);
	if (n < 1000) return under1000(n);
	if (n < 1_000_000) {
		const th = Math.floor(n / 1000);
		const r = n % 1000;
		return under1000(th) + ' thousand' + (r ? ' ' + under1000(r) : '');
	}
	if (n < 1_000_000_000) {
		const mil = Math.floor(n / 1_000_000);
		const r = n % 1_000_000;
		return under1000(mil) + ' million' + (r ? ' ' + intToWords(r) : '');
	}
	return String(n); // too big — leave as-is rather than mangle
}

const IRREGULAR_ORDINAL: Record<number, string> = {
	1: 'first',
	2: 'second',
	3: 'third',
	5: 'fifth',
	8: 'eighth',
	9: 'ninth',
	12: 'twelfth'
};

function ordinalToWords(n: number): string {
	if (IRREGULAR_ORDINAL[n]) return IRREGULAR_ORDINAL[n];
	const w = intToWords(n);
	if (n % 10 === 0 && n % 100 !== 0) return w.replace(/ty$/, 'tieth'); // twenty -> twentieth
	const o = n % 10;
	if (IRREGULAR_ORDINAL[o] && n > 20) {
		return w.replace(new RegExp(ONES[o] + '$'), IRREGULAR_ORDINAL[o]); // twenty-one -> twenty-first
	}
	return w + 'th';
}

function yearToWords(y: number): string {
	if (y >= 2000 && y <= 2009) return 'two thousand' + (y % 100 ? ' ' + under100(y % 100) : '');
	const hi = Math.floor(y / 100);
	const lo = y % 100;
	const loWords = lo === 0 ? 'hundred' : lo < 10 ? 'oh ' + ONES[lo] : under100(lo);
	return under100(hi) + ' ' + loWords; // 2026 -> twenty twenty-six; 1999 -> nineteen ninety-nine
}

function timeToWords(h: number, m: number): string {
	const hr = intToWords(h === 0 ? 12 : h > 12 ? h - 12 : h);
	if (m === 0) return hr + " o'clock";
	if (m < 10) return hr + ' oh ' + ONES[m]; // 5:02 -> five oh two
	return hr + ' ' + under100(m); // 5:30 -> five thirty
}

export function speakableText(text: string): string {
	let s = text;
	// Normalize Unicode hyphen-family to plain ASCII hyphen first — Azure DragonHD
	// mangles the non-breaking hyphen (U+2011), en-dash (U+2013), em-dash (U+2014)
	// and figure-dash (U+2012) in currency ranges, running "$400‑$460" together
	// into what sounds like "four hundred dara sixty" (operator-reported
	// 2026-07-06). Also convert " - " between two currency amounts into "to" so
	// the range reads naturally as "four hundred to four hundred sixty dollars."
	s = s.replace(/[‐‑‒–—]/g, '-');
	s = s.replace(/(\$\s*\d[\d,]*(?:\.\d+)?)\s*-\s*(\$)/g, '$1 to $2');
	// Currency: "$1,145" -> "1145 dollars", "$399.99" -> "399 dollars and 99 cents".
	// Strip the leading $ and the thousands commas so intToWords sees a single
	// integer, then append "dollars"/"dollar" as a trailing word. Placed BEFORE
	// the standalone-integer rule so intToWords gets the whole number, not each
	// comma-separated group ("$1,145" was being read as "one, one hundred
	// forty-five" — operator-reported 2026-07-06). Cents use "and N cents" only
	// when non-zero; whole dollars drop the cents. Singular "dollar" for $1.
	s = s.replace(/\$\s*(\d[\d,]*)(?:\.(\d{2}))?\b/g, (_m, whole, cents) => {
		const dollars = Number(whole.replace(/,/g, ''));
		if (Number.isNaN(dollars)) return _m;
		const dollarWords = intToWords(dollars);
		const unit = dollars === 1 ? 'dollar' : 'dollars';
		if (!cents || cents === '00') return `${dollarWords} ${unit}`;
		const centsNum = Number(cents);
		const centsWords = intToWords(centsNum);
		const centsUnit = centsNum === 1 ? 'cent' : 'cents';
		return `${dollarWords} ${unit} and ${centsWords} ${centsUnit}`;
	});
	// Unit abbreviations right after a number: "8 GB" -> "8 gigabytes",
	// "16GB" -> "16 gigabytes", "500 MB" -> "500 megabytes", "2 TB" -> "2 terabytes".
	// Azure otherwise speaks these letter-by-letter as "gee bee" (which sounds
	// like "G by" — operator-reported 2026-07-06). Case-insensitive on the unit;
	// word boundary on the far side so we don't touch "GBP" or "MBps".
	const UNIT_WORD: Record<string, string> = {
		gb: 'gigabytes',
		mb: 'megabytes',
		tb: 'terabytes',
		kb: 'kilobytes',
		ghz: 'gigahertz',
		mhz: 'megahertz'
	};
	s = s.replace(/(\d+)\s*(GB|MB|TB|KB|GHz|MHz)\b/gi, (_m, num, unit) => {
		const key = unit.toLowerCase();
		return `${num} ${UNIT_WORD[key] ?? unit}`;
	});
	// Clock times first (they own the colon): 5:02, 12:30
	s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h, mm) => timeToWords(Number(h), Number(mm)));
	// Month + day → ordinal: "May 31" -> "May thirty-first"
	s = s.replace(
		new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2})\\b`, 'g'),
		(_m, mon, d) => `${mon} ${ordinalToWords(Number(d))}`
	);
	// Standalone ordinals: 31st, 1st, 22nd
	s = s.replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, (_m, n) => ordinalToWords(Number(n)));
	// Years 1900–2099
	s = s.replace(/\b(?:19|20)\d{2}\b/g, (m) => yearToWords(Number(m)));
	// Decimals: 3.5 -> three point five
	s = s.replace(
		/\b(\d+)\.(\d+)\b/g,
		(_m, a, b) =>
			intToWords(Number(a)) +
			' point ' +
			String(b)
				.split('')
				.map((d) => ONES[Number(d)])
				.join(' ')
	);
	// Product / model numbers: leave "RTX 5060", "GTX 1080", "iPhone 15",
	// "Pixel 9", "Ryzen 7700" etc. as digits so Azure reads them naturally
	// ("fifty sixty" not "five thousand sixty" — operator-reported 2026-07-06
	// after listening to "the RTX five thousand sixty Ti"). Mask the digits
	// with a placeholder that the standalone-integer rule below won't match,
	// then restore. Case-insensitive on the brand word; matches when the
	// digits sit right after with an optional space.
	const modelPrefixes = ['RTX', 'GTX', 'iPhone', 'iPad', 'Pixel', 'Ryzen', 'Xeon', 'Threadripper'];
	const modelRe = new RegExp(`\\b(${modelPrefixes.join('|')})(\\s+)(\\d{1,5})\\b`, 'gi');
	const stashed: string[] = [];
	s = s.replace(modelRe, (_m, brand, gap, num) => {
		stashed.push(num);
		return `${brand}${gap}MODELIDX${stashed.length - 1}ENDIDX`;
	});
	// Any remaining standalone integer (won't touch alphanumerics like "16GB" or "v2")
	s = s.replace(/\b\d+\b/g, (m) => (m.length > 9 ? m : intToWords(Number(m))));
	// Restore the model-number placeholders.
	s = s.replace(/MODELIDX(\d+)ENDIDX/g, (_m, idx) => stashed[Number(idx)]);
	return s;
}
