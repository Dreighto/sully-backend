import { describe, expect, it } from 'vitest';
import { isAffirmation } from '$lib/server/routing/confirm';

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
			'👍'
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
});
