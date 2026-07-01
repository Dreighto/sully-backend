import type { UIMessage, TextUIPart } from 'ai';

export type NormalizationMode = 'chat' | 'voice' | 'walkie';

type ModeRuleSet = {
	transform: boolean;
	stripFillers: boolean;
	insertSentenceBreaks: boolean;
};

type TermCorrection = {
	pattern: RegExp;
	replacement: string;
};

const MODE_RULES: Record<NormalizationMode, ModeRuleSet> = {
	chat: { transform: false, stripFillers: false, insertSentenceBreaks: false },
	voice: { transform: true, stripFillers: true, insertSentenceBreaks: false },
	walkie: { transform: true, stripFillers: true, insertSentenceBreaks: false }
};

const DOMAIN_CORRECTIONS: TermCorrection[] = [
	{ pattern: /\blogue\s*os\b/gi, replacement: 'LogueOS' },
	{ pattern: /\bjet\s*son\b/gi, replacement: 'Jetson' },
	{ pattern: /\borin nano\s*super\b/gi, replacement: 'Orin Nano Super' },
	{ pattern: /\bnanosuper\b/gi, replacement: 'Nano Super' },
	{ pattern: /\bwalkie[ -]?talkie\b/gi, replacement: 'walkie-talkie' },
	{ pattern: /\btalk\s*back\b/gi, replacement: 'talkback' },
	{ pattern: /\bsully\b/gi, replacement: 'Sully' },
	{ pattern: /\bsullia\b/gi, replacement: 'Sully' },
	{ pattern: /\bsulli\b/gi, replacement: 'Sully' }
];

const LEADING_FILLERS = /^(?:\s*(?:um+|uh+|erm+|ah+|mm+|hmm+)\b(?:\s|,|\.|!|\?)*)+/i;
const REPEATED_PHRASES = [
	/\b(i need you to)\s+\1\b/gi,
	/\b(can you)\s+\1\b/gi,
	/\b(i want you to)\s+\1\b/gi
];
const REPEATED_WORD = /\b([a-z][a-z']+)\b(?:\s+\1\b)+/gi;
const NUMBER_WORDS = new Set([
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
	'ten'
]);

export function sourceToNormalizationMode(source?: string): NormalizationMode {
	if (source === 'voice') return 'voice';
	if (source === 'walkie' || source === 'talkback') return 'walkie';
	return 'chat';
}

export function normalizeInputText(text: string, mode: NormalizationMode): string {
	const rules = MODE_RULES[mode];
	let next = text.trim();
	if (!next) return '';

	// Typed chat is preserved verbatim (trim only). The STT cleanup chain below
	// runs ONLY for voice/walkie dictation. Applying it to typed chat corrupts
	// pasted multi-line code (newlines flattened), loop variables and lowercase
	// 'i', deliberately repeated words, and appends a stray terminal period —
	// all silently, both in the persisted message and what the model reads.
	if (!rules.transform) return next;

	next = normalizeWhitespace(next);
	if (rules.stripFillers) next = next.replace(LEADING_FILLERS, '');
	next = collapseRepeatedPhrases(next);
	next = collapseRepeatedWords(next);
	next = applyDomainCorrections(next);
	if (rules.insertSentenceBreaks) next = insertSentenceBreaks(next);
	next = normalizePunctuationSpacing(next);
	next = capitalizeSentenceStarts(next);
	next = normalizePronounI(next);
	next = ensureTerminalPunctuation(next);
	return next;
}

export function normalizeLatestUserMessage(
	messages: UIMessage[],
	mode: NormalizationMode
): UIMessage[] {
	let patched = false;
	return messages.map((message, index) => {
		const isLatestUser =
			message.role === 'user' &&
			index ===
				[...messages]
					.map((m, i) => (m.role === 'user' ? i : -1))
					.filter((i) => i >= 0)
					.at(-1);

		if (!isLatestUser) return message;

		const parts = message.parts.map((part) => {
			if (part.type !== 'text') return part;
			patched = true;
			return {
				...part,
				text: normalizeInputText(part.text, mode)
			} satisfies TextUIPart;
		});

		return patched ? { ...message, parts } : message;
	});
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function collapseRepeatedPhrases(text: string): string {
	let next = text;
	for (const pattern of REPEATED_PHRASES) {
		next = next.replace(pattern, '$1');
	}
	return next;
}

function collapseRepeatedWords(text: string): string {
	return text.replace(REPEATED_WORD, (match, word) => {
		return NUMBER_WORDS.has(String(word).toLowerCase()) ? match : word;
	});
}

function applyDomainCorrections(text: string): string {
	return DOMAIN_CORRECTIONS.reduce(
		(current, correction) => current.replace(correction.pattern, correction.replacement),
		text
	);
}

function insertSentenceBreaks(text: string): string {
	return text;
}

function normalizePunctuationSpacing(text: string): string {
	return text
		.replace(/\s+([,.;!?])/g, '$1')
		.replace(/([,.;!?])(?=[^\s"'`)\]}])/g, '$1 ')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

function capitalizeSentenceStarts(text: string): string {
	return text.replace(/(^|[.!?]\s+)([a-z])/g, (_match, prefix, letter) => {
		return `${prefix}${letter.toUpperCase()}`;
	});
}

function normalizePronounI(text: string): string {
	return text.replace(/\bi\b/g, 'I');
}

function ensureTerminalPunctuation(text: string): string {
	if (!text) return text;
	if (/[.!?]"?$/.test(text)) return text;
	return `${text}.`;
}
