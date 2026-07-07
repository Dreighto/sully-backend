// Deterministic no-ai-slop cleanup applied to model reply text at persist time.
// The prompt rules ask models not to emit em-dashes, but they do it anyway
// ~half the time — so this is the reliable net (operator caught em-dashes in a
// voice transcript, 2026-07-07). Runs on EVERY persisted reply (text + voice)
// via persistAssistantTurn, so no surface drifts.
//
// Scope is deliberately narrow: only the em-dash, the single most visible slop
// tell. Code and inline-code are left ALONE — an em-dash inside code or an
// identifier is legitimate. The other slop rules stay prompt-only (rewriting
// filler deterministically would risk mangling real content).

const FENCE_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

/** Replace prose em-dashes (and spaced en-dashes) with a comma. Number ranges
 *  like "3–5" keep their en-dash; only the spaced-connector form is touched. */
function deSlopSegment(text: string): string {
	return (
		text
			// " — " / "—" / "word—word" → comma. Collapse any surrounding spaces
			// so "Got it — KFC" and "Got it—KFC" both become "Got it, KFC".
			.replace(/\s*—\s*/g, ', ')
			// Spaced en-dash used as a connector (not a numeric range).
			.replace(/\s+–\s+/g, ', ')
			// A comma we just introduced immediately before end-punctuation reads
			// wrong ("done, ." ); tidy the rare case.
			.replace(/,\s+([.?!,;:])/g, '$1')
	);
}

/** De-slop reply text, preserving fenced and inline code verbatim. */
export function deSlop(text: string): string {
	if (!text || (!text.includes('—') && !text.includes('–'))) return text;
	const parts = text.split(FENCE_RE);
	// split() with a capturing group interleaves [prose, code, prose, code, ...];
	// odd indices are the captured code spans — leave those untouched.
	return parts.map((seg, i) => (i % 2 === 1 ? seg : deSlopSegment(seg))).join('');
}
