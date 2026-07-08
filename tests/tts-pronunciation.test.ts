import { describe, it, expect } from 'vitest';
import { speakableText } from '../src/lib/server/tts_normalize';
import {
	acronymSpokenAlias,
	applyVoicePronunciationPrelude,
	yearToSpoken
} from '../src/lib/server/tts_pronunciation';

describe('yearToSpoken', () => {
	it('speaks 2026 as twenty twenty-six', () => {
		expect(yearToSpoken(2026)).toBe('twenty twenty-six');
	});

	it('covers representative years in 1900–2099', () => {
		expect(yearToSpoken(1999)).toBe('nineteen ninety-nine');
		expect(yearToSpoken(2000)).toBe('two thousand');
		expect(yearToSpoken(2005)).toBe('two thousand five');
		expect(yearToSpoken(2010)).toBe('twenty ten');
		expect(yearToSpoken(1900)).toBe('nineteen hundred');
		expect(yearToSpoken(1905)).toBe('nineteen oh-five');
	});
});

describe('speakableText — years (voice path)', () => {
	it('wraps 2026 with a spoken-year sub alias', () => {
		expect(speakableText('Shipped in 2026')).toBe(
			'Shipped in <sub alias="twenty twenty-six">2026</sub>'
		);
	});

	it('wraps other 4-digit years naturally', () => {
		expect(speakableText('1999 and 2000')).toBe(
			'<sub alias="nineteen ninety-nine">1999</sub> and <sub alias="two thousand">2000</sub>'
		);
	});
});

describe('speakableText — acronyms (word-boundary, voice only)', () => {
	const cases: Array<[string, string, string]> = [
		['JSON', 'jason', 'Parse JSON files'],
		['README', 'read me', 'Check the README first'],
		['CLI', 'C L I', 'Use the CLI tool'],
		['URL', 'U R L', 'Open this URL now'],
		['API', 'A P I', 'The API returns data'],
		['npm', 'N P M', 'Run npm install'],
		['SQL', 'sequel', 'Write SQL queries']
	];

	for (const [token, alias, sentence] of cases) {
		it(`speaks ${token} as "${alias}"`, () => {
			expect(acronymSpokenAlias(token)).toBe(alias);
			expect(speakableText(sentence)).toContain(`<sub alias="${alias}">${token}</sub>`);
		});
	}

	it('does not rewrite acronyms embedded inside other words', () => {
		expect(speakableText('JSONSchema is different')).toBe('JSONSchema is different');
	});
});

describe('speakableText — paths and URLs', () => {
	it('collapses https URLs into speakable host/path words', () => {
		expect(applyVoicePronunciationPrelude('See https://x.com/a for details')).toBe(
			'See x dot com slash a for details'
		);
		expect(speakableText('See https://x.com/a for details')).toBe(
			'See x dot com slash a for details'
		);
	});

	it('simplifies long absolute unix paths to the last segment', () => {
		expect(applyVoicePronunciationPrelude('File at /home/dreighto/dev/x')).toBe(
			'File at x'
		);
		expect(speakableText('File at /home/dreighto/dev/x')).toBe('File at x');
	});
});

describe('speakableText — units and symbols', () => {
	it('speaks numeric percent as "N percent"', () => {
		expect(speakableText('50% complete')).toBe(
			'<sub alias="fifty percent">50%</sub> complete'
		);
		expect(speakableText('3.5% growth')).toBe(
			'<sub alias="three point five percent">3.5%</sub> growth'
		);
	});

	it('replaces ampersand with "and"', () => {
		expect(speakableText('salt & pepper')).toBe('salt  and  pepper');
	});

	it('drops arrow tokens', () => {
		expect(speakableText('a -> b')).toBe('a   b');
		expect(speakableText('x => y')).toBe('x   y');
	});
});

describe('speakableText — double-processing guard', () => {
	it('leaves already-spoken year words untouched when no digits remain', () => {
		expect(speakableText('Release twenty twenty-six')).toBe('Release twenty twenty-six');
	});
});
