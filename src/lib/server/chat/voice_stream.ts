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
// Output is SSE (text/event-stream): `meta`, `sentence` (fired→TTS), `audio`
// (in-order, base64 WAV), `done` (transcript + timing). Timestamps are ms since
// turn start; the proof that first-audio precedes generation-complete lives in
// the `done` event + per-event `ms`.

import { VOICE_OLLAMA_URL, resolveTtsUrl } from '../voice_runtime';
import { speakableText } from '../tts_normalize';
import { VOICE_TOOL_SCHEMAS, runVoiceToolLoop } from './voice_tools';
import { OLLAMA_API_KEY } from './web_search';

const OLLAMA = VOICE_OLLAMA_URL;
const TTS_URL = resolveTtsUrl();

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
export function extractSentences(buf: string): { sentences: string[]; rest: string } {
	const sentences: string[] = [];
	let start = 0;
	let i = 0;
	while (i < buf.length) {
		const c = buf[i];
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

	// Synthesize one sentence on Kokoro (Jetson). Returns the WAV bytes.
	async function synth(text: string): Promise<Buffer> {
		const r = await fetch(`${TTS_URL}/tts`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: speakableText(text), voice: opts.voice ?? 'am_fenrir' }),
			signal: opts.signal
		});
		if (!r.ok) throw new Error(`kokoro /tts HTTP ${r.status}`);
		return Buffer.from(await r.arrayBuffer());
	}

	const synths: Array<Promise<Buffer>> = [];
	let idx = 0;
	let firstDispatchMs: number | null = null;
	let genDone = false;
	// Wake the drainer when a new sentence is fired or generation ends.
	let notify: () => void = () => {};
	let waiter = new Promise<void>((r) => (notify = r));

	function fireSentence(text: string) {
		const i = idx++;
		if (firstDispatchMs === null) firstDispatchMs = rel();
		sse(controller, enc, 'sentence', { i, text, fired_ms: rel() });
		synths[i] = synth(text);
		notify();
		waiter = new Promise<void>((r) => (notify = r));
	}

	// In-order drainer: await synths[e] in sequence, emit audio in sentence order.
	let firstAudioMs: number | null = null;
	const drain = (async () => {
		let e = 0;
		for (;;) {
			if (e < synths.length) {
				try {
					const wav = await synths[e];
					if (firstAudioMs === null) firstAudioMs = rel();
					sse(controller, enc, 'audio', {
						i: e,
						ms: rel(),
						bytes: wav.length,
						wav_b64: wav.toString('base64')
					});
				} catch (err) {
					sse(controller, enc, 'audio_error', { i: e, error: (err as Error).message });
				}
				e++;
			} else if (genDone) {
				return;
			} else {
				await waiter;
			}
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
				let obj: { message?: { content?: string; tool_calls?: unknown[] }; done?: boolean };
				try {
					obj = JSON.parse(line);
				} catch {
					continue;
				}
				const msg = obj.message;
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
					const { sentences, rest } = extractSentences(sentenceBuf);
					sentenceBuf = rest;
					for (const s of sentences) fireSentence(s);
				}
			}
		}
		// Final flush — emit the trailing fragment even without punctuation.
		if (sentenceBuf.trim()) fireSentence(sentenceBuf.trim());
		const generationCompleteMs = rel();
		genDone = true;
		notify();
		await drain;
		sse(controller, enc, 'done', {
			transcript: transcript.trim(),
			generation_complete_ms: generationCompleteMs,
			first_tts_dispatch_ms: firstDispatchMs,
			first_audio_ms: firstAudioMs,
			sentences: idx
		});
		return { toolTurn: toolMode, transcript: transcript.trim() };
	} catch (e) {
		genDone = true;
		notify();
		await drain.catch(() => {});
		throw e;
	}
}
