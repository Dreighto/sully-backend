// Track A of the voice-pipeline research plan (2026-07-06).
// Optional context-aware layer that rewrites tricky terms into SSML before
// the deterministic `speakableText` normalizer runs. Off by default via
// TRACK_A_ENABLED=1. Any failure or timeout falls back to the raw text so
// this can never break the shipped Azure TTS path.
//
// Trigger heuristics keep the LLM call cheap: only invoke on utterances that
// contain at least one candidate for confusion (uppercase acronyms, tech
// model numbers, currency next to an ambiguous unit). Everything else skips
// the layer entirely and preserves the current PR #109 behavior.

// Read process.env at call time so tests and prod both see the current value.
// SvelteKit's $env/dynamic/private proxy caches under vitest and misses the
// per-test mutations we rely on to keep this layer verifiable.
const REWRITER_MAX_INPUT_CHARS = 400;

const ACRONYM_RE = /\b[A-Z]{2,6}s?\b/;
const MODEL_NUMBER_RE =
	/\b(RTX|GTX|iPhone|Pixel|Ryzen|Xeon|Threadripper|Galaxy|Snapdragon|Core i\d)\s?\d/i;
const CURRENCY_WITH_UNIT_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s?(GB|TB|MB|GHz|MHz|K|M|B)\b/i;

const SYSTEM_PROMPT = `You rewrite short assistant replies into audio-friendly text for a text-to-speech engine. Rules:
- Keep meaning identical.
- Wrap tech model numbers as <say-as interpret-as="characters">RTX</say-as> <say-as interpret-as="cardinal">5060</say-as> when the model letters should be spelled and the digits read as one number.
- Wrap acronyms that should be spelled letter by letter (RTX, GTX, GPU, CPU, SSD, USB, HDMI) as <say-as interpret-as="characters">RTX</say-as>. Do not wrap acronyms that are read as words (NASA, LASER).
- Wrap currency amounts that could be misread as <say-as interpret-as="currency" language="en-US">1145 USD</say-as>.
- Wrap ambiguous units with <sub alias="eight gigabytes">8 GB</sub>.
- Leave everything else untouched.
- Output ONLY the rewritten text. No prose, no reasoning, no code fences.
- If nothing needs rewriting, output the input verbatim.`;

export function shouldApplyContextualRewrite(text: string): boolean {
	if (!text || text.length > REWRITER_MAX_INPUT_CHARS) return false;
	return ACRONYM_RE.test(text) || MODEL_NUMBER_RE.test(text) || CURRENCY_WITH_UNIT_RE.test(text);
}

export function trackAEnabled(): boolean {
	return process.env.TRACK_A_ENABLED === '1';
}

export async function applyContextualPronunciation(
	text: string,
	opts?: { signal?: AbortSignal }
): Promise<string> {
	if (!trackAEnabled()) return text;
	if (!shouldApplyContextualRewrite(text)) return text;

	const endpoint = process.env.TRACK_A_ENDPOINT ?? 'https://ollama.com/api/chat';
	const model = process.env.TRACK_A_MODEL ?? 'gpt-oss:120b-cloud';
	const timeoutMs = Number(process.env.TRACK_A_TIMEOUT_MS ?? 1200);
	const apiKey = process.env.OLLAMA_API_KEY;
	const isCloud = endpoint.includes('ollama.com');
	if (isCloud && !apiKey) return text;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
		if (!resp.ok) return text;
		const data = (await resp.json()) as { message?: { content?: string } };
		const rewritten = data.message?.content?.trim();
		if (!rewritten) return text;
		if (rewritten.length > text.length * 8) return text;
		return rewritten;
	} catch {
		return text;
	} finally {
		clearTimeout(timeout);
	}
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
