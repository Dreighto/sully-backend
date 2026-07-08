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

import { VOICE_OLLAMA_URL } from '../voice_runtime';
import { speakableText } from '../tts_normalize';
import { synthesizeAzureTts, DEFAULT_AZURE_VOICE } from '../azure_tts';
import { normalizeWavPeak } from '../wav_gain';
import { VOICE_TOOL_SCHEMAS, runVoiceToolLoop } from './voice_tools';
import { OLLAMA_API_KEY } from './web_search';
import { composeTimeout, readWithIdle } from './voice_seam_timeout';
import type { SentenceLogEntry } from './voice_turn_registry';
import { extractSentences } from './voice_sentence_boundaries';

export { extractSentences } from './voice_sentence_boundaries';

const OLLAMA = VOICE_OLLAMA_URL;

// WI-8 (voice seam timeouts): bound each Jetson seam so a wedged bridge can't
// hang the mic forever. A fired timeout surfaces as a TimeoutError, which the
// catch below routes to HARD FAILURE (the barge-in/abort path stays keyed on the
// client signal). Helpers live in ./voice_seam_timeout so they're shared with
// the tool loop and unit-testable. All deadlines env-overridable for the field.
const VOICE_TTS_TIMEOUT_MS = Number(process.env.VOICE_TTS_TIMEOUT_MS) || 15000;
// Total ceiling on the streaming generation fetch (a backstop; the idle
// watchdog is the fast-fail for a mid-stream wedge).
const VOICE_OLLAMA_MAX_MS = Number(process.env.VOICE_OLLAMA_MAX_MS) || 120000;
// Fast-fail: no chunk from the model stream for this long → the bridge is wedged.
const VOICE_IDLE_READ_MS = Number(process.env.VOICE_IDLE_READ_MS) || 20000;
// Fast-fail on the HEADER wait specifically: the fetch resolves when response
// headers arrive, but a stalled Ollama-Pro queue can hold headers for up to the
// full VOICE_OLLAMA_MAX_MS ceiling — hanging the mic ~2 min before failing
// (deep audit 2026-07-07). Bound the first-byte/header wait separately so a
// cloud stall fails fast; the 120s total still governs a genuinely long reply
// once streaming has begun.
const VOICE_HEADER_MS = Number(process.env.VOICE_HEADER_MS) || 25000;

// Short, varied filler phrases spoken the moment a tool call fires, so the
// operator hears a beat of Sully's voice while the search/fetch round-trip
// runs (1-3 seconds of otherwise-silent dead air). Rotated per turn so the
// same filler doesn't repeat when the operator asks several lookup-shaped
// questions in a row. Sentence-final punctuation lets the reorder-drainer
// treat these like any other sentence.
const LOOK_UP_FILLERS = [
	'One sec.',
	'Checking.',
	'Hang on a sec.',
	'Give me a moment.',
	'Looking now.'
];
const PULL_UP_FILLERS = ['Pulling that up.', 'One sec.', 'Grabbing that now.'];

type SseController = ReadableStreamDefaultController<Uint8Array>;

export type VoiceStreamResult = {
	toolTurn: boolean;
	transcript: string;
	/** True if the underlying signal aborted before generation completed (the
	 *  client/operator interrupted, or `/api/chat/voice-truncate` fired). When
	 *  true, the caller should compute the heard prefix via the registry's
	 *  `heardPrefixFromLog(sentenceLog, audio_end_ms)` and persist THAT. */
	aborted: boolean;
	/** Per-sentence timing log: when each boundary surfaced and when the WAV
	 *  bytes were emitted. The caller uses this with the truncate-time
	 *  audio_end_ms to compute exactly what the operator heard. */
	sentenceLog: SentenceLogEntry[];
};

function sse(c: SseController, enc: TextEncoder, event: string, data: unknown) {
	c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
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
		/** Server-minted response id for this turn — surfaced to the client via the
		 *  meta SSE event so it can call `/api/chat/voice-truncate` with it. */
		responseId?: string;
	},
	controller: SseController,
	enc: TextEncoder
): Promise<VoiceStreamResult> {
	const t0 = Date.now();
	const rel = () => Date.now() - t0;
	sse(controller, enc, 'meta', {
		turn_started_ms: t0,
		model: opts.model,
		streaming: true,
		response_id: opts.responseId ?? null
	});

	// Sentence log: every boundary push pre-fills i/text/fired_ms; the drainer
	// fills audio_ms when the WAV bytes are emitted. Single shared array so the
	// caller can pass it straight to `heardPrefixFromLog` on abort.
	const sentenceLog: SentenceLogEntry[] = [];

	// Synthesize one sentence via Azure Speech. Returns the WAV bytes.
	// Wave 5 rewire (2026-07-06, operator directive): was Kokoro on the Jetson
	// bridge; Azure gives cleaner iteration on the surfaces while the app is
	// still being stabilized. Requests WAV (riff-24khz-16bit-mono-pcm) so the
	// client's audio decoding contract (base64 WAV per sentence) is unchanged.
	// No trailing-silence padding here — that's a Talkback-only concern for a
	// single fully-buffered clip; padding every per-sentence chunk here would
	// stack into exactly the choppy, over-paused cadence this rewire is fixing.
	async function synth(text: string): Promise<Buffer> {
		const r = await synthesizeAzureTts({
			text: speakableText(text),
			voice: opts.voice ?? DEFAULT_AZURE_VOICE,
			format: 'wav',
			signal: composeTimeout(opts.signal, VOICE_TTS_TIMEOUT_MS),
			ssml: true
		});
		// Peak-normalize to -3 dBFS: raw Azure output reads as "very low" on
		// iPhone speakers (operator finding, build 193).
		return normalizeWavPeak(Buffer.from(await r.arrayBuffer()));
	}

	const synths: Array<Promise<Buffer>> = [];
	let idx = 0;
	let firstDispatchMs: number | null = null;
	let genDone = false;
	// Wake the drainer when a new sentence is fired or generation ends.
	let notify: () => void = () => {};
	let waiter = new Promise<void>((r) => (notify = r));

	const nonFillerTranscriptParts: string[] = [];

	function fireSentence(text: string, opts?: { filler?: boolean }) {
		const i = idx++;
		const firedMs = rel();
		if (firstDispatchMs === null) firstDispatchMs = firedMs;
		sentenceLog.push({ i, text, fired_ms: firedMs, audio_ms: null });
		const payload: Record<string, unknown> = { i, text, fired_ms: firedMs };
		if (opts?.filler) payload.filler = true;
		else nonFillerTranscriptParts.push(text);
		sse(controller, enc, 'sentence', payload);
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
					const audioMs = rel();
					if (firstAudioMs === null) firstAudioMs = audioMs;
					// Record when the WAV bytes were emitted so the truncate path can
					// compute the exact heard prefix from the operator's audio_end_ms.
					const entry = sentenceLog[e];
					if (entry) entry.audio_ms = audioMs;
					sse(controller, enc, 'audio', {
						i: e,
						ms: audioMs,
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

	// Stream the model. When the model ends in `-cloud`, route the call to
	// Ollama Pro (https://ollama.com/api/chat) with Bearer auth instead of
	// the local Jetson Ollama socket — same chat-API shape, but lets us run
	// a bigger model (gpt-oss:120b-cloud, gemini-3-flash-preview-cloud etc.)
	// for the voice surface without local VRAM constraints. The cloud route
	// drops keep_alive and num_ctx — those are Jetson-only knobs.
	// Cloud model ids come in both `-cloud` (gpt-oss:120b-cloud) and `:cloud`
	// (deepseek-v4-flash:cloud) forms. Matching only `-cloud` mis-routed the
	// colon form to the LOCAL Ollama → ECONNREFUSED (operator voice, 2026-07-07).
	const isCloudModel = /[:-]cloud$/.test(opts.model);
	const body: Record<string, unknown> = isCloudModel
		? { model: opts.model, messages: opts.messages, stream: true }
		: {
				model: opts.model,
				messages: opts.messages,
				stream: true,
				keep_alive: opts.keepAlive,
				options: { num_ctx: opts.numCtx }
			};
	// Attach the voice tool schemas so the model can call web_search / web_fetch
	// mid-conversation instead of falsely telling the operator "I can't do that."
	// Was previously local-only (the `!isCloudModel` guard) because early Ollama
	// Cloud models mishandled the tools parameter; that limitation lifted, and
	// gpt-oss:120b-cloud / DeepSeek Cloud both accept tools on the standard
	// Ollama chat API now. Cloud requests also need the Bearer auth header, so
	// we thread the API key through both branches (2026-07-06).
	if (OLLAMA_API_KEY) body.tools = VOICE_TOOL_SCHEMAS;

	// Hoisted so the catch block can see them on early-abort (truncate fires
	// before any token landed → reader/transcript never bound below the fetch).
	let transcript = '';
	let toolMode = false;
	let firstTokenMs: number | null = null;
	let promptEvalCount: number | null = null;
	let promptEvalMs: number | null = null;

	try {
		// The fetch is INSIDE the try so a truncate / barge-in that fires before
		// Ollama responds (AbortError thrown before the readLoop ever starts) is
		// still caught and translated into `aborted: true` — the caller needs the
		// sentenceLog to compute the heard prefix (which is empty in this case).
		const endpoint = isCloudModel ? 'https://ollama.com/api/chat' : `${OLLAMA}/api/chat`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (isCloudModel && OLLAMA_API_KEY) headers.Authorization = `Bearer ${OLLAMA_API_KEY}`;
		// Header guard: abort if response headers do not arrive within
		// VOICE_HEADER_MS (a cloud queue stall), separate from the 120s total.
		// Cleared the instant headers land, so a long-but-streaming reply keeps
		// the full ceiling. Aborting with a TimeoutError routes to hard failure
		// (same as the seam timeouts), converting the 2-min hang into a fast fail.
		const headerAbort = new AbortController();
		const headerTimer = setTimeout(
			() =>
				headerAbort.abort(
					new DOMException(`voice header wait exceeded ${VOICE_HEADER_MS}ms`, 'TimeoutError')
				),
			VOICE_HEADER_MS
		);
		const genBase = opts.signal
			? AbortSignal.any([opts.signal, headerAbort.signal])
			: headerAbort.signal;
		let resp: Response;
		try {
			resp = await fetch(endpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: composeTimeout(genBase, VOICE_OLLAMA_MAX_MS)
			});
		} finally {
			clearTimeout(headerTimer);
		}
		if (!resp.ok || !resp.body) throw new Error(`ollama /api/chat HTTP ${resp.status}`);

		const reader = resp.body.getReader();
		const dec = new TextDecoder();
		let lineBuf = '';
		let sentenceBuf = '';
		let decided: 'speak' | null = null;

		readLoop: for (;;) {
			const { value, done } = await readWithIdle(reader, VOICE_IDLE_READ_MS);
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
							// Rotate the tool-start filler so it doesn't sound canned when
							// the operator hits it several times in the same conversation
							// (2026-07-06 gripe: hearing "Let me look that up" every single
							// turn got annoying fast). Kept short and varied; picked
							// per-turn via a cheap random index rather than a session
							// counter (no shared state to keep clean).
							onToolStart: (toolName: string) =>
								fireSentence(
									toolName === 'web_fetch'
										? PULL_UP_FILLERS[Math.floor(Math.random() * PULL_UP_FILLERS.length)]
										: LOOK_UP_FILLERS[Math.floor(Math.random() * LOOK_UP_FILLERS.length)],
									{ filler: true }
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
		const doneTranscript = nonFillerTranscriptParts.join(' ').trim() || transcript.trim();
		sse(controller, enc, 'done', {
			transcript: doneTranscript,
			generation_complete_ms: generationCompleteMs,
			first_tts_dispatch_ms: firstDispatchMs,
			first_audio_ms: firstAudioMs,
			first_token_ms: firstTokenMs,
			prompt_eval_count: promptEvalCount,
			prompt_eval_ms: promptEvalMs,
			sentences: idx
		});
		return {
			toolTurn: toolMode,
			transcript: doneTranscript,
			aborted: false,
			sentenceLog
		};
	} catch (e) {
		// Signal abort is the truncate / barge-in path — drain whatever sentences
		// have already been synthesized (so the client gets the trailing `audio`
		// events for what we did produce) and return cleanly. The caller decides
		// what to persist by consulting the sentence log + audio_end_ms. Any other
		// failure (Ollama 500, network drop) re-throws as before.
		const isAbort =
			(e instanceof Error && e.name === 'AbortError') || opts.signal?.aborted === true;
		genDone = true;
		notify();
		if (isAbort) {
			await drain.catch(() => {});
			return {
				toolTurn: toolMode,
				transcript: transcript.trim(),
				aborted: true,
				sentenceLog
			};
		}
		await drain.catch(() => {});
		throw e;
	}
}
