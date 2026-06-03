// Natural-language confirmation detector for ask-before-dispatch (Phase 2).
// Deliberately CONSERVATIVE: matches only a known set of short affirmation
// phrases after normalization, so an ambiguous reply ("yes but rewrite X")
// does NOT trigger a dispatch — it's treated as a fresh turn and the pending
// proposal expires. Works identically for typed and spoken (transcribed) input.

const AFFIRMATIONS = new Set([
	'y',
	'yes',
	'yeah',
	'yep',
	'yup',
	'ok',
	'okay',
	'sure',
	'go',
	'go ahead',
	'do it',
	'do it please',
	'send it',
	'ship it',
	'go for it',
	'please do',
	'yes please',
	'yes go',
	'yes go ahead',
	'sounds good',
	'lets do it',
	'let us do it',
	'confirm',
	'confirmed',
	'affirmative',
	'absolutely',
	'sure go ahead',
	'👍',
	'👍🏻'
]);

/** True only for a short, unambiguous affirmation (≤40 chars, exact phrase match). */
export function isAffirmation(text: string): boolean {
	const t = (text || '')
		.toLowerCase()
		.replace(/['’]/g, '') // "let's do it" → "lets do it"
		.replace(/[.!?,]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!t || t.length > 40) return false;
	return AFFIRMATIONS.has(t);
}
