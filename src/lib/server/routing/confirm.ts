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
		.replace(/['’ʼ]/g, '') // straight, curly (U+2019), modifier (U+02BC) apostrophes
		.replace(/[.!?,]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!t || t.length > 40) return false;
	return AFFIRMATIONS.has(t);
}

// ── Routing-ask answers (R2.1) ─────────────────────────────────────────────
// Conservative — matches only a known set of short phrases for defer or
// sibling so an ambiguous reply can't accidentally pick one.

const DEFER_ANSWERS = new Set([
	'hold it',
	'hold that',
	'wait',
	'later',
	'after this one',
	'after this',
	'when its done',
	'when its finished',
	'wait until that finishes',
	'wait until this finishes',
	'defer',
	'hold on',
	'not yet',
	'finish this first'
]);

const SIBLING_ANSWERS = new Set([
	'separately',
	'run it separately',
	'start a separate one',
	'a new task',
	'do it now too',
	'run it now too',
	'both',
	'do both',
	'run both',
	'sibling',
	'new task',
	'separate task',
	'do it separately'
]);

/**
 * Detect a routing-ask answer from the operator. Returns 'defer', 'sibling',
 * or null (not a routing-ask answer — treat as a normal turn).
 * Conservative: short, exact phrase set; apostrophes stripped like isAffirmation.
 */
export function isRoutingAnswer(text: string): 'defer' | 'sibling' | null {
	const t = (text || '')
		.toLowerCase()
		.replace(/['’ʼ]/g, '') // straight, curly (U+2019), modifier (U+02BC) apostrophes
		.replace(/[.!?,]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!t || t.length > 60) return null;
	if (DEFER_ANSWERS.has(t)) return 'defer';
	if (SIBLING_ANSWERS.has(t)) return 'sibling';
	return null;
}
