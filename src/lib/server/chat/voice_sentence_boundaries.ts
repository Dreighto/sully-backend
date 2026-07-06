// Sentence/clause boundary detection for the voice-streaming pipeline. Pure,
// zero-dependency — split out of voice_stream.ts (Wave 4, 2026-07-06) as the
// one safe piece to move; the synth/fireSentence/drain reorder-queue
// internals stay put (closures over per-call mutable state — a factory
// refactor, not a file-move).

// Minimum clause length (chars from `start`) before a comma / semicolon / colon
// counts as a flush-worthy boundary. Smaller → audio starts sooner but rhythm
// gets choppy; larger → smoother but defeats the point of clause chunking.
// 32 lands at roughly "noun-phrase + verb-phrase" length in English.
const CLAUSE_MIN_CHARS = 32;

// No-punctuation runaway guard: flush a pending fragment as a "sentence" once it
// exceeds this many chars, so a model that forgets punctuation can't starve TTS.
const FLUSH_CHARS = 220;

// Cheap abbreviation guard so "Dr." / "e.g." don't split mid-thought. Lowercased,
// trailing dot stripped for comparison.
const ABBREVS = new Set([
	'mr',
	'mrs',
	'ms',
	'dr',
	'st',
	'vs',
	'etc',
	'e.g',
	'i.e',
	'no',
	'fig',
	'inc',
	'ltd',
	'jr',
	'sr',
	'gen',
	'sgt',
	'approx'
]);

// Pull complete sentences off the front of `buf`. Returns the sentences found and
// the unconsumed remainder. Guards: decimals (3.5), single trailing punctuation
// at the very end of the buffer (might be a decimal/more — wait for the next
// chunk), and a small abbreviation set. A boundary is:
//   - `.!?` followed by whitespace or a closing quote/bracket (sentence-final), OR
//   - `,;:` followed by whitespace WHEN the current pending segment is already
//     long enough that a clause break is worth the latency win (clause-level
//     chunking — operator decision 2026-06-28, replaces the prior sentence-only
//     gating that left first-audio waiting ~1.5s for a complete sentence).
export function extractSentences(buf: string): { sentences: string[]; rest: string } {
	const sentences: string[] = [];
	let start = 0;
	let i = 0;
	while (i < buf.length) {
		const c = buf[i];
		// Clause-level boundary (commas + semicolons + colons). Fires only when
		// the pending segment is already long enough. Guards mirror the
		// sentence-final logic: next-char must be whitespace; numeric commas
		// (1,000) are skipped because both sides are digits; close-quote/bracket
		// suffixes consume cleanly.
		if (c === ',' || c === ';' || c === ':') {
			const next = buf[i + 1];
			if (next === undefined) break;
			// Numeric thousand-separator (1,000) — keep going.
			if (c === ',' && /\d/.test(buf[i - 1] ?? '') && /\d/.test(next)) {
				i++;
				continue;
			}
			// Only honor as a flush if (a) next char is whitespace and (b)
			// pending segment has reached the min clause length.
			if (/\s/.test(next) && i - start >= CLAUSE_MIN_CHARS) {
				let end = i + 1;
				while (end < buf.length && /[,;:"'’”)\]]/.test(buf[end])) end++;
				sentences.push(buf.slice(start, end).trim());
				while (end < buf.length && /\s/.test(buf[end])) end++;
				start = end;
				i = end;
				continue;
			}
		}
		if (c === '.' || c === '!' || c === '?') {
			const next = buf[i + 1];
			// Punctuation at the very end — we don't yet know what follows
			// (could be a decimal digit, more punctuation, or a space). Wait.
			if (next === undefined) break;
			// Decimal like 3.5 — digit on both sides of a dot is not a boundary.
			if (c === '.' && /\d/.test(buf[i - 1] ?? '') && /\d/.test(next)) {
				i++;
				continue;
			}
			// List enumerator like "9." / "10." at the START of a line/fragment — the
			// dot follows digits that are the first non-whitespace token on the line,
			// so it's a list marker, not a sentence end. Keep it with the item text so
			// Kokoro never says a bare "nine." / "ten." (PRO-967). (Mid-sentence "3.5"
			// is the decimal guard above; a mid-line "Section 5." is NOT a line-start
			// enumerator and still splits.)
			if (c === '.') {
				let ns = i - 1;
				while (ns >= 0 && /\d/.test(buf[ns])) ns--;
				ns++; // first digit of the run
				if (ns < i && buf.slice(buf.lastIndexOf('\n', i) + 1, ns).trim() === '') {
					i++;
					continue;
				}
			}
			// Boundary only if the next char is whitespace or a closing quote/bracket.
			if (/[\s"'’”)\]]/.test(next)) {
				// Abbreviation guard: look at the word ending right before the dot.
				if (c === '.') {
					const wordStart = buf.lastIndexOf(' ', i - 1) + 1;
					const word = buf.slice(wordStart, i).toLowerCase();
					if (ABBREVS.has(word)) {
						i++;
						continue;
					}
				}
				// Consume any trailing run of punctuation/quotes (e.g. ?!" ).
				let end = i + 1;
				while (end < buf.length && /[.!?"'’”)\]]/.test(buf[end])) end++;
				sentences.push(buf.slice(start, end).trim());
				while (end < buf.length && /\s/.test(buf[end])) end++;
				start = end;
				i = end;
				continue;
			}
		}
		i++;
	}
	let rest = buf.slice(start);
	// Runaway guard: no boundary but the fragment is long → flush it.
	if (rest.length >= FLUSH_CHARS) {
		const cut = rest.lastIndexOf(' ', FLUSH_CHARS);
		const at = cut > 40 ? cut : rest.length;
		sentences.push(rest.slice(0, at).trim());
		rest = rest.slice(at).trimStart();
	}
	return { sentences: sentences.filter(Boolean), rest };
}
