import { describe, expect, it } from 'vitest';
import { isAffirmation, isRoutingAnswer } from '$lib/server/routing/confirm';

describe('isAffirmation', () => {
	it('accepts clear short confirmations (text + voice phrasings)', () => {
		for (const t of [
			'yes',
			'Yes!',
			'yeah',
			'yep',
			'sure',
			'ok',
			'okay',
			'go',
			'go ahead',
			'do it',
			'send it',
			'ship it',
			'go for it',
			'please do',
			'yes please',
			"let's do it",
			'yes go ahead',
			'sounds good',
			'confirmed',
			'absolutely',
			'\u{1F44D}'
		]) {
			expect(isAffirmation(t), `should accept "${t}"`).toBe(true);
		}
	});

	it('rejects negatives, bare politeness, and non-confirmations', () => {
		for (const t of [
			'no',
			'nope',
			'not yet',
			'wait',
			'stop',
			'hold on',
			'cancel',
			"don't",
			'please'
		]) {
			expect(isAffirmation(t), `should reject "${t}"`).toBe(false);
		}
	});

	it('rejects an ambiguous reply that merely STARTS with yes (stability guard)', () => {
		expect(isAffirmation('yes but actually rewrite the whole dashboard instead')).toBe(false);
		expect(isAffirmation('yeah, and also can you investigate the orb crash')).toBe(false);
	});

	it('rejects empty / unrelated turns', () => {
		expect(isAffirmation('')).toBe(false);
		expect(isAffirmation('what time is it')).toBe(false);
	});

	it('IMPORTANT 4 - accepts curly-apostrophe variants (iOS/STT output)', () => {
		// String.fromCodePoint keeps the hex literals formatter-proof:
		// prettier cannot convert 0x2019 / 0x02bc to actual curly-quote bytes.
		const curly = String.fromCodePoint(0x2019); // U+2019 RIGHT SINGLE QUOTATION MARK
		const modifier = String.fromCodePoint(0x02bc); // U+02BC MODIFIER LETTER APOSTROPHE
		// "let's do it" with curly apostrophe (iOS keyboard / STT) -> strips to "lets do it" -> in set
		expect(isAffirmation('let' + curly + 's do it')).toBe(true);
		// "let's do it" with modifier apostrophe
		expect(isAffirmation('let' + modifier + 's do it')).toBe(true);
	});
});

describe('isRoutingAnswer - curly apostrophe handling (IMPORTANT 4)', () => {
	it('handles curly apostrophes in defer answers', () => {
		// "when it's done" with U+2019 curly apostrophe -> strips to "when its done" -> defer.
		const curly = String.fromCodePoint(0x2019);
		expect(isRoutingAnswer('when it' + curly + 's done')).toBe('defer');
	});
	it('handles curly apostrophes in sibling answers (and plain ASCII still works)', () => {
		expect(isRoutingAnswer('run it separately')).toBe('sibling');
		expect(isRoutingAnswer('separately')).toBe('sibling');
	});
});
