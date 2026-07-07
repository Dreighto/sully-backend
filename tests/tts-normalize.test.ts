import { describe, it, expect } from 'vitest';
import { speakableText } from '../src/lib/server/tts_normalize';

describe('speakableText — spoken-number normalization for TTS', () => {
	it('speaks clock times naturally (the "5:02 -> five oh two" fix)', () => {
		expect(speakableText("It's 5:02 PM")).toBe("It's five oh two PM");
		expect(speakableText('at 5:30')).toBe('at five thirty');
		expect(speakableText('12:00 noon')).toBe("twelve o'clock noon");
		expect(speakableText('13:05')).toBe('one oh five');
	});

	it('speaks dates and years', () => {
		expect(speakableText('Sunday, May 31, 2026')).toBe(
			'Sunday, May thirty-first, twenty twenty-six'
		);
		expect(speakableText('2000')).toBe('two thousand');
		expect(speakableText('1999')).toBe('nineteen ninety-nine');
	});

	it('speaks ordinals, integers and decimals', () => {
		expect(speakableText('the 31st')).toBe('the thirty-first');
		expect(speakableText('I have 3 things')).toBe('I have three things');
		expect(speakableText('3.5 hours')).toBe('three point five hours');
	});

	it('leaves alphanumeric tokens alone', () => {
		// v2, iOS17, macOS15 etc. stay as-is — no digit-adjacent unit to expand.
		expect(speakableText('v2 of the app')).toBe('v2 of the app');
	});

	it('expands storage/RAM/clock units so Azure does not read them letter-by-letter', () => {
		// Operator-reported 2026-07-06: "8 GB" was pronounced "gee bee" (which
		// sounds like "G by"). Expand to spoken word regardless of whether
		// there is a space between the number and the unit.
		expect(speakableText('16GB of RAM')).toBe('sixteen gigabytes of RAM');
		expect(speakableText('8 GB')).toBe('eight gigabytes');
		expect(speakableText('500 MB drive')).toBe('five hundred megabytes drive');
		expect(speakableText('2 TB')).toBe('two terabytes');
		expect(speakableText('3.2 GHz clock')).toBe('three point two gigahertz clock');
	});

	it('speaks currency with dollars and cents, and handles ranges', () => {
		// Operator-reported 2026-07-06: "$400‑$460" (Unicode non-breaking hyphen
		// U+2011 from LLM output) rendered as "Dara sixty" instead of "four
		// hundred dollars to four hundred sixty dollars." Normalize hyphen
		// family and speak the currency out.
		expect(speakableText('$1')).toBe('one dollar');
		expect(speakableText('$1.50')).toBe('one dollar and fifty cents');
		expect(speakableText('$1,145')).toBe('one thousand one hundred forty-five dollars');
		expect(speakableText('$399.99')).toBe(
			'three hundred ninety-nine dollars and ninety-nine cents'
		);
		expect(speakableText('$400‑$460 range')).toBe(
			'four hundred dollars to four hundred sixty dollars range'
		);
	});

	it('keeps tech model numbers as bare digits', () => {
		// Operator-reported 2026-07-06: Azure DragonHD speaks "5060" naturally
		// ("fifty sixty") when left as digits, but says "five thousand sixty"
		// if intToWords touches it first. Same for iPhone 15, GTX 1080, etc.
		expect(speakableText('the RTX 5060 Ti')).toBe('the RTX 5060 Ti');
		expect(speakableText('RTX 5080')).toBe('RTX 5080');
		expect(speakableText('iPhone 15 Pro')).toBe('iPhone 15 Pro');
		expect(speakableText('GTX 1080 Ti')).toBe('GTX 1080 Ti');
		expect(speakableText('Pixel 9')).toBe('Pixel 9');
	});
});
