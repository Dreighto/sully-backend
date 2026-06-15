// Sentence-streaming voice reply (T-stream / VOICE_REPLY_STREAMING).
//
// The old voice-reply path awaits the ENTIRE model reply before any audio, so
// the operator waits out the whole generation before hearing a word. This path
// streams tokens from Ollama and, the moment a sentence boundary lands, fires
// that sentence to Kokoro (Jetson TTS) WHILE the model keeps generating — so the
// first sentence is audible almost immediately with the rest flowing behind it.
//
// Ordering: sentences are synthesized concurrently (fired on each boundary) but
// EMITTED in strict sentence order via a reorder drainer — even if Kokoro returns
// sentence 2 before sentence 1, sentence 1's audio is emitted first. The client
// just plays the `audio` events in arrival order.
//
// Tool turns are NOT handled here: if the model's first output is a tool_call we
// return {toolTurn:true} immediately and the caller falls back to the proven
// non-streaming tool loop (tool behavior unchanged). We never emit a sentence
// before confirming this is a plain speak turn.
//
// Per-sentence TTS is itself STREAMED: a long sentence is sent to Kokoro's
// /tts/stream with clause-splitting, which yields the first clause's audio
// before the whole sentence is synthesized — so the first audio of a long first
// sentence lands sooner. A short sentence uses the buffered /tts (one fast
// synth; clause-splitting a short line regresses it). Each Kokoro segment is a
// self-contained WAV, emitted as its own `audio` event (carrying `seg`), still
// in strict sentence-then-segment order via the reorder drainer.
//
// Output is SSE (text/event-stream): `meta`, `sentence` (fired→TTS), `audio`
// (in-order, base64 WAV — one per Kokoro segment, with `i`=sentence, `seg`=segment
// index), `done` (transcript + timing). Timestamps are ms since turn start; the
// proof that first-audio precedes generation-complete lives in the `done` event
// + per-event `ms`.

import { VOICE_OLLAMA_URL, resolveTtsUrl } from '../voice_runtime';
import { speakableText } from '../tts_normalize';
import { VOICE_TOOL_SCHEMAS, runVoiceToolLoop } from './voice_tools';
import { OLLAMA_API_KEY } from './web_search';

const OLLAMA = VOICE_OLLAMA_URL;
const TTS_URL = resolveTtsUrl();

// A sentence at/over this many speakable chars is streamed via /tts/stream with
// clause-splitting (the first clause's audio lands early). Shorter sentences go
// through the buffered /tts — measured warm, a short clause-split synth lands its
// first audio LATER than just buffering the (already-fast) whole synth.
const STREAM_SPLIT_MIN_CHARS = 80;

// Until the first sentence dispatches, fire on a clause boundary once the opening
// fragment reaches this length — so a LONG first sentence's opening clause goes to
// TTS without waiting out the whole sentence (the dominant long-reply TTFA cost:
// measured first_tts_dispatch ~1.4s on a long opener). 40 fires at the first
// natural comma of a long opener (~600-700ms) to keep TTFA reliably under 1.5s;
// short openers (a brief "Well," / "Ah,") stay under the threshold and are
// unaffected. Lower = faster first word but riskier of a clipped-sounding opener.
const FIRST_CLAUSE_FLUSH_CHARS = 40;

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

type SseController = ReadableStreamDefaultController<Uint8Array>;

export type VoiceStreamResult = { toolTurn: boolean; transcript: string };

function sse(c: SseController, enc: TextEncoder, event: string, data: unknown) {
	c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

// Pull complete sentences off the front of `buf`. Returns the sentences found and
// the unconsumed remainder. Guards: decimals (3.5), single trailing punctuation
// at the very end of the buffer (might be a decimal/more — wait for the next
// chunk), and a small abbreviation set. A boundary is `.!?` followed by
// whitespace or a closing quote/bracket.
//
// `clauseFlushChars` (>0) additionally treats a `,;:` clause boundary as a flush
// point ONCE the pending fragment is at least that long — so a LONG opening
// sentence's first clause can fire to TTS without waiting for the period. The
// caller enables this only until the first sentence has dispatched (it is the
// TTFA-critical opener); the rest of the reply keeps natural sentence boundaries.
export function extractSentences(
	buf: string,
	clauseFlushChars = 0
): { sentences: string[]; rest: string } {
	const sentences: string[] = [];
	let start = 0;
	let i = 0;
	while (i < buf.length) {
		const c = buf[i];
		if (
			clauseFlushChars > 0 &&
			(c === ',' || c === ';' || c === ':') &&
			i - start >= clauseFlushChars
		) {
			const next = buf[i + 1];
			if (next === undefined) break; // wait — more may follow
			// Number-internal punctuation ("3,000", "3:30") — not a clause break.
			const digitBoth = /\d/.test(buf[i - 1] ?? '') && /\d/.test(next);
			if (!digitBoth && /\s/.test(next)) {
				sentences.push(buf.slice(start, i + 1).trim()); // keep the comma (natural pause)
				let end = i + 1;
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

export async function runVoiceStreamingSpeak(
	opts: {
		model: string;
		messages: Array<{ role: string; content: string }>;
		keepAlive: string;
		numCtx: number;
		voice?: string;
		signal?: AbortSignal;
		taskId?: string;
	},
	controller: SseController,
	enc: TextEncoder
): Promise<VoiceStreamResult> {
	const t0 = Date.now();
	const rel = () => Date.now() - t0;
	sse(controller, enc, 'meta', { turn_started_ms: t0, model: opts.model, streaming: true });

	// Stream-synthesize one sentence on Kokoro (Jetson), pushing each WAV segment
	// to `onSegment` the moment it arrives. A long sentence goes to /tts/stream
	// with clause-splitting (first clause's audio lands early, framed as
	// `<u32 LE length><WAV>` records); a short sentence uses the buffered /tts
	// (one segment — faster warm than per-clause synth overhead).
	async function synthSentence(text: string, onSegment: (wav: Buffer) => void): Promise<void> {
		const speak = speakableText(text);
		if (speak.length < STREAM_SPLIT_MIN_CHARS) {
			const r = await fetch(`${TTS_URL}/tts`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: speak, voice: opts.voice ?? 'am_fenrir' }),
				signal: opts.signal
			});
			if (!r.ok) throw new Error(`kokoro /tts HTTP ${r.status}`);
			onSegment(Buffer.from(await r.arrayBuffer()));
			return;
		}
		const r = await fetch(`${TTS_URL}/tts/stream`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: speak, voice: opts.voice ?? 'am_fenrir', split: 'clause' }),
			signal: opts.signal
		});
		if (!r.ok || !r.body) throw new Error(`kokoro /tts/stream HTTP ${r.status}`);
		// Reassemble `<u32 LE byte length><WAV bytes>` frames from the chunked body.
		const reader = r.body.getReader();
		let buf = Buffer.alloc(0);
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value && value.length) buf = Buffer.concat([buf, Buffer.from(value)]);
			for (;;) {
				if (buf.length < 4) break;
				const n = buf.readUInt32LE(0);
				if (buf.length < 4 + n) break;
				onSegment(Buffer.from(buf.subarray(4, 4 + n)));
				buf = buf.subarray(4 + n);
			}
		}
		if (buf.length)
			throw new Error(`kokoro /tts/stream incomplete frame (${buf.length}B trailing)`);
	}

	// Per-sentence synthesis state. Segments arrive concurrently across sentences
	// but are emitted in strict sentence-then-segment order by the drainer below.
	type SentenceState = { segments: Buffer[]; done: boolean; error?: Error };
	const states: SentenceState[] = [];
	let idx = 0;
	let firstDispatchMs: number | null = null;
	let genDone = false;
	// Condition-variable: capture `waiter` BEFORE inspecting state and await it
	// only after no progress — signal() resolves the current waiter AND re-arms,
	// so a wake that races an inspection is never lost.
	let wake: () => void = () => {};
	let waiter!: Promise<void>;
	const arm = () => {
		waiter = new Promise<void>((r) => (wake = r));
	};
	arm();
	const signal = () => {
		const w = wake;
		arm();
		w();
	};

	function fireSentence(text: string) {
		const i = idx++;
		if (firstDispatchMs === null) firstDispatchMs = rel();
		sse(controller, enc, 'sentence', { i, text, fired_ms: rel() });
		const st: SentenceState = { segments: [], done: false };
		states[i] = st;
		void (async () => {
			try {
				await synthSentence(text, (wav) => {
					st.segments.push(wav);
					signal();
				});
			} catch (err) {
				st.error = err as Error;
			} finally {
				st.done = true;
				signal();
			}
		})();
		signal();
	}

	// In-order drainer: emit each sentence's segments in order, advancing to the
	// next sentence only once the current one is fully produced AND drained.
	let firstAudioMs: number | null = null;
	let segmentsTotal = 0;
	const drain = (async () => {
		let e = 0; // sentence cursor
		let segOut = 0; // segments of sentence e already emitted
		for (;;) {
			const w = waiter; // capture before inspecting (no lost wakeups)
			let progressed = false;
			while (e < idx) {
				const st = states[e];
				if (!st) break;
				while (segOut < st.segments.length) {
					const wav = st.segments[segOut];
					if (firstAudioMs === null) firstAudioMs = rel();
					sse(controller, enc, 'audio', {
						i: e,
						seg: segOut,
						ms: rel(),
						bytes: wav.length,
						wav_b64: wav.toString('base64')
					});
					segOut++;
					segmentsTotal++;
					progressed = true;
				}
				if (st.done && segOut >= st.segments.length) {
					if (st.error) {
						sse(controller, enc, 'audio_error', { i: e, error: st.error.message });
					}
					e++;
					segOut = 0;
					progressed = true;
					continue;
				}
				break; // sentence e still producing — wait for more segments
			}
			if (genDone && e >= idx) return;
			if (!progressed) await w;
		}
	})();

	// Stream the model.
	const body: Record<string, unknown> = {
		model: opts.model,
		messages: opts.messages,
		stream: true,
		keep_alive: opts.keepAlive,
		options: { num_ctx: opts.numCtx }
	};
	if (OLLAMA_API_KEY) body.tools = VOICE_TOOL_SCHEMAS;

	const resp = await fetch(`${OLLAMA}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: opts.signal
	});
	if (!resp.ok || !resp.body) throw new Error(`ollama /api/chat HTTP ${resp.status}`);

	const reader = resp.body.getReader();
	const dec = new TextDecoder();
	let lineBuf = '';
	let sentenceBuf = '';
	let transcript = '';
	let decided: 'speak' | null = null;
	let toolMode = false;
	// Diagnostics: time-to-first-token and Ollama's reported prompt_eval cost.
	let firstTokenMs: number | null = null;
	let promptEvalCount: number | null = null;
	let promptEvalMs: number | null = null;

	try {
		readLoop: for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			lineBuf += dec.decode(value, { stream: true });
			let nl: number;
			while ((nl = lineBuf.indexOf('\n')) >= 0) {
				const line = lineBuf.slice(0, nl).trim();
				lineBuf = lineBuf.slice(nl + 1);
				if (!line) continue;
				let obj: {
					message?: { content?: string; tool_calls?: unknown[] };
					done?: boolean;
					prompt_eval_count?: number;
					prompt_eval_duration?: number;
				};
				try {
					obj = JSON.parse(line);
				} catch {
					continue;
				}
				const msg = obj.message;
				if (firstTokenMs === null && msg?.content) firstTokenMs = rel();
				if (obj.done) {
					promptEvalCount = obj.prompt_eval_count ?? null;
					promptEvalMs =
						obj.prompt_eval_duration != null ? Math.round(obj.prompt_eval_duration / 1e6) : null;
				}
				// Early decision — before emitting any sentence.
				if (!decided) {
					if (msg?.tool_calls && msg.tool_calls.length) {
						// TOOL TURN — abandon the stream and run the proven non-streaming
						// tool loop (tool behavior unchanged), then sentence-stream its
						// final answer + the "let me look that up" filler through the same
						// TTS pipeline. No sentence has been emitted yet, so we never speak
						// a sentence and then discover it was a tool turn.
						await reader.cancel().catch(() => {});
						toolMode = true;
						const { content } = await runVoiceToolLoop({
							model: opts.model,
							messages: opts.messages,
							keepAlive: opts.keepAlive,
							numCtx: opts.numCtx,
							signal: opts.signal,
							taskId: opts.taskId,
							onToolStart: (toolName: string) =>
								fireSentence(
									toolName === 'web_fetch' ? 'Let me pull that up.' : 'Let me look that up.'
								)
						});
						transcript = content;
						const { sentences, rest } = extractSentences(content + ' ');
						for (const s of sentences) fireSentence(s);
						if (rest.trim()) fireSentence(rest.trim());
						break readLoop;
					}
					if (msg?.content && msg.content.trim()) decided = 'speak';
				}
				if (decided === 'speak' && msg?.content) {
					sentenceBuf += msg.content;
					transcript += msg.content;
					// Only the TTFA-critical opener gets clause-flushing; once the first
					// sentence has dispatched, revert to natural sentence boundaries.
					const clauseFlush = firstDispatchMs === null ? FIRST_CLAUSE_FLUSH_CHARS : 0;
					const { sentences, rest } = extractSentences(sentenceBuf, clauseFlush);
					sentenceBuf = rest;
					for (const s of sentences) fireSentence(s);
				}
			}
		}
		// Final flush — emit the trailing fragment even without punctuation.
		if (sentenceBuf.trim()) fireSentence(sentenceBuf.trim());
		const generationCompleteMs = rel();
		genDone = true;
		signal();
		await drain;
		sse(controller, enc, 'done', {
			transcript: transcript.trim(),
			generation_complete_ms: generationCompleteMs,
			first_tts_dispatch_ms: firstDispatchMs,
			first_audio_ms: firstAudioMs,
			first_token_ms: firstTokenMs,
			prompt_eval_count: promptEvalCount,
			prompt_eval_ms: promptEvalMs,
			sentences: idx,
			segments_total: segmentsTotal
		});
		return { toolTurn: toolMode, transcript: transcript.trim() };
	} catch (e) {
		genDone = true;
		signal();
		await drain.catch(() => {});
		throw e;
	}
}
