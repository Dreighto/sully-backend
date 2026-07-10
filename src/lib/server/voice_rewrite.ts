// W4-A (SUL-194): contextual pronunciation rewriter.
//
// An optional LLM pass that runs BEFORE the deterministic SSML normalizer
// (tts_normalize.speakableText), for SPOKEN output only, and only when an
// allow-list regex fires (acronyms, tech model numbers, ambiguous units,
// currency, file paths). Everything else skips the layer entirely.
//
// Ships DARK: VOICE_REWRITER_MODEL is empty by default, which makes
// rewriteForSpeech a pure pass-through. The layer is enabled deliberately by
// setting that env var to a model name.
//
// Safety contract: rewriteForSpeech can only ever improve or no-op. A gate
// miss, the disabled flag, a timeout, or ANY error returns the input
// byte-for-byte unchanged, so this can never block a turn beyond its budget
// nor corrupt the audio path.
//
// The rewriter emits PLAIN speakable text, not SSML. Its output is re-run
// through tts_normalize as the trusted deterministic base (the rewriter is
// not trusted to be SSML-safe), so any stray markup it produces is escaped
// downstream rather than injected into the SSML document.
//
// Env is read at call time (not module load) so tests and prod both observe
// the current value; SvelteKit's $env proxy caches under vitest and misses
// the per-test mutations the tests rely on.

const REWRITER_MAX_INPUT_CHARS = 400;
const DEFAULT_TIMEOUT_MS = 200;
const DEFAULT_ENDPOINT = 'https://ollama.com/api/chat';

const ACRONYM_RE = /\b[A-Z]{2,6}s?\b/;
const MODEL_NUMBER_RE =
	/\b(RTX|GTX|iPhone|Pixel|Ryzen|Xeon|Threadripper|Galaxy|Snapdragon|Core i\d)\s?\d/i;
const UNIT_RE = /\b\d+(?:\.\d+)?\s?(GB|TB|MB|KB|GHz|MHz)\b/i;
const CURRENCY_RE = /\$\s?\d/;
const FILE_PATH_RE = /(?:^|\s)(?:~|\.{0,2})?\/[\w.-]+\/[\w./-]+/;

const SYSTEM_PROMPT = `You rewrite one short assistant reply into plain speakable text for a text-to-speech engine. Rules:
- Rewrite ONLY tokens that a TTS engine would mispronounce: acronyms, tech model numbers, ambiguous units, currency, and file paths.
- Spell out acronyms that are read letter by letter (GPU becomes G P U, RTX becomes R T X). Leave acronyms read as words alone (NASA, LASER).
- Read tech model numbers naturally (RTX 5060 becomes R T X fifty sixty).
- Expand ambiguous units (8 GB becomes eight gigabytes).
- Read currency naturally ($1,145 becomes one thousand one hundred forty five dollars).
- Read file paths as their last segment or in a speakable form.
- Never change the meaning. Never add or remove information.
- Output PLAIN TEXT only. No SSML, no markup, no code fences, no prose, no reasoning.
- If nothing needs rewriting, output the input verbatim.`;

export interface VoiceRewriteMetrics {
	invocations: number;
	rewrites: number;
	timeouts: number;
	fallbacks: number;
}

const metrics: VoiceRewriteMetrics = {
	invocations: 0,
	rewrites: 0,
	timeouts: 0,
	fallbacks: 0
};

/** Snapshot of the invocation/timeout/fallback counters (TTFT metrics pattern, #128). */
export function getVoiceRewriteMetrics(): VoiceRewriteMetrics {
	return { ...metrics };
}

/** Reset the counters. Test-only helper. */
export function resetVoiceRewriteMetrics(): void {
	metrics.invocations = 0;
	metrics.rewrites = 0;
	metrics.timeouts = 0;
	metrics.fallbacks = 0;
}

/** Empty VOICE_REWRITER_MODEL means the layer is disabled (ships dark). */
export function voiceRewriterEnabled(): boolean {
	return (process.env.VOICE_REWRITER_MODEL ?? '').trim().length > 0;
}

/** True when the text contains at least one pronunciation-hostile candidate. */
export function shouldRewriteForSpeech(text: string): boolean {
	if (!text || text.length > REWRITER_MAX_INPUT_CHARS) return false;
	return (
		ACRONYM_RE.test(text) ||
		MODEL_NUMBER_RE.test(text) ||
		UNIT_RE.test(text) ||
		CURRENCY_RE.test(text) ||
		FILE_PATH_RE.test(text)
	);
}

/**
 * Optional contextual rewrite of pronunciation-hostile tokens into plain
 * speakable text. Returns the input unchanged when disabled, when the gate
 * misses, or on any timeout or error. The caller must re-run the result
 * through tts_normalize.speakableText (see speakableTextForSpeech).
 */
export async function rewriteForSpeech(
	text: string,
	opts?: { signal?: AbortSignal }
): Promise<string> {
	if (!voiceRewriterEnabled()) return text;
	if (!shouldRewriteForSpeech(text)) return text;

	const model = (process.env.VOICE_REWRITER_MODEL ?? '').trim();
	const endpoint = process.env.VOICE_REWRITER_ENDPOINT ?? DEFAULT_ENDPOINT;
	const timeoutMs = Number(process.env.VOICE_REWRITER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
	const apiKey = process.env.OLLAMA_API_KEY;
	const isCloud = endpoint.includes('ollama.com');
	if (isCloud && !apiKey) return text;

	metrics.invocations += 1;

	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const signal = opts?.signal ? mergeSignals(opts.signal, controller.signal) : controller.signal;

	try {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (isCloud && apiKey) headers.Authorization = `Bearer ${apiKey}`;

		const resp = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model,
				stream: false,
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: text }
				]
			}),
			signal
		});
		if (!resp.ok) {
			recordFallback('http_' + resp.status, model);
			return text;
		}

		const data = (await resp.json()) as { message?: { content?: string } };
		const rewritten = data.message?.content?.trim();
		if (!rewritten) {
			recordFallback('empty', model);
			return text;
		}
		// Reject a runaway response rather than shipping it to the TTS engine.
		if (rewritten.length > text.length * 8) {
			recordFallback('oversize', model);
			return text;
		}

		metrics.rewrites += 1;
		logMetric('rewritten', model);
		return rewritten;
	} catch {
		if (timedOut) metrics.timeouts += 1;
		recordFallback(timedOut ? 'timeout' : 'error', model);
		return text;
	} finally {
		clearTimeout(timeout);
	}
}

// A fallback is any invoked attempt that did not produce a usable rewrite;
// timeouts are the counted subset that were aborted by our own budget timer.
function recordFallback(reason: string, model: string): void {
	metrics.fallbacks += 1;
	logMetric(reason, model);
}

// The metrics log line mirrors the #128 [voice-metrics] pattern so the layer
// is measurable from server logs before it is tuned (grep '[voice-rewrite]').
function logMetric(outcome: string, model: string): void {
	console.log(
		'[voice-rewrite]',
		JSON.stringify({
			model,
			outcome,
			invocations: metrics.invocations,
			rewrites: metrics.rewrites,
			timeouts: metrics.timeouts,
			fallbacks: metrics.fallbacks
		})
	);
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
	if (a.aborted) return a;
	if (b.aborted) return b;
	const ctl = new AbortController();
	const onA = () => ctl.abort(a.reason);
	const onB = () => ctl.abort(b.reason);
	a.addEventListener('abort', onA, { once: true });
	b.addEventListener('abort', onB, { once: true });
	return ctl.signal;
}
