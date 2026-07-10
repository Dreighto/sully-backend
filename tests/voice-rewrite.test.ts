import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getVoiceRewriteMetrics,
	resetVoiceRewriteMetrics,
	rewriteForSpeech,
	shouldRewriteForSpeech,
	voiceRewriterEnabled
} from '../src/lib/server/voice_rewrite';
import { speakableText, speakableTextForSpeech } from '../src/lib/server/tts_normalize';

function chatResponse(content: string, status = 200): Response {
	return new Response(JSON.stringify({ message: { content } }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('shouldRewriteForSpeech (allow-list gate)', () => {
	it('triggers on standalone acronyms', () => {
		expect(shouldRewriteForSpeech('I need a new GPU today')).toBe(true);
		expect(shouldRewriteForSpeech('Any SSD recommendations')).toBe(true);
	});

	it('triggers on tech model numbers', () => {
		expect(shouldRewriteForSpeech('The RTX 5060 Ti is nice')).toBe(true);
		expect(shouldRewriteForSpeech('iPhone 15 Pro Max')).toBe(true);
	});

	it('triggers on ambiguous units', () => {
		expect(shouldRewriteForSpeech('it has 16GB of memory')).toBe(true);
		expect(shouldRewriteForSpeech('a 3.2 GHz clock')).toBe(true);
	});

	it('triggers on currency', () => {
		expect(shouldRewriteForSpeech('it costs $1,145 total')).toBe(true);
	});

	it('triggers on file paths', () => {
		expect(shouldRewriteForSpeech('open /etc/hosts now')).toBe(true);
		expect(shouldRewriteForSpeech('see ~/dev/sully/readme')).toBe(true);
	});

	it('skips plain conversational text', () => {
		expect(shouldRewriteForSpeech('how was your day')).toBe(false);
		expect(shouldRewriteForSpeech('the weather is fine right now')).toBe(false);
	});

	it('skips oversize inputs', () => {
		const long = 'RTX 5060 '.repeat(60);
		expect(shouldRewriteForSpeech(long)).toBe(false);
	});
});

describe('voiceRewriterEnabled', () => {
	const original = process.env.VOICE_REWRITER_MODEL;
	afterEach(() => {
		if (original === undefined) delete process.env.VOICE_REWRITER_MODEL;
		else process.env.VOICE_REWRITER_MODEL = original;
	});

	it('defaults off when the env is unset', () => {
		delete process.env.VOICE_REWRITER_MODEL;
		expect(voiceRewriterEnabled()).toBe(false);
	});

	it('stays off when the env is empty or whitespace', () => {
		process.env.VOICE_REWRITER_MODEL = '   ';
		expect(voiceRewriterEnabled()).toBe(false);
	});

	it('turns on when a model name is set', () => {
		process.env.VOICE_REWRITER_MODEL = 'gpt-oss:120b-cloud';
		expect(voiceRewriterEnabled()).toBe(true);
	});
});

describe('rewriteForSpeech', () => {
	const originalModel = process.env.VOICE_REWRITER_MODEL;
	const originalKey = process.env.OLLAMA_API_KEY;
	const originalTimeout = process.env.VOICE_REWRITER_TIMEOUT_MS;

	beforeEach(() => {
		vi.restoreAllMocks();
		resetVoiceRewriteMetrics();
	});

	afterEach(() => {
		if (originalModel === undefined) delete process.env.VOICE_REWRITER_MODEL;
		else process.env.VOICE_REWRITER_MODEL = originalModel;
		if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
		else process.env.OLLAMA_API_KEY = originalKey;
		if (originalTimeout === undefined) delete process.env.VOICE_REWRITER_TIMEOUT_MS;
		else process.env.VOICE_REWRITER_TIMEOUT_MS = originalTimeout;
	});

	it('is a pass-through when disabled (dark by default)', async () => {
		delete process.env.VOICE_REWRITER_MODEL;
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const out = await rewriteForSpeech('The RTX 5060 Ti is nice');
		expect(out).toBe('The RTX 5060 Ti is nice');
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(getVoiceRewriteMetrics().invocations).toBe(0);
	});

	it('skips the LLM entirely on a gate miss', async () => {
		process.env.VOICE_REWRITER_MODEL = 'test-model';
		process.env.OLLAMA_API_KEY = 'test-key';
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const out = await rewriteForSpeech('how was your day');
		expect(out).toBe('how was your day');
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(getVoiceRewriteMetrics().invocations).toBe(0);
	});

	it('returns the rewritten plain text on a gate hit', async () => {
		process.env.VOICE_REWRITER_MODEL = 'test-model';
		process.env.OLLAMA_API_KEY = 'test-key';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			chatResponse('The R T X fifty sixty Ti is nice')
		);
		const out = await rewriteForSpeech('The RTX 5060 Ti is nice');
		expect(out).toBe('The R T X fifty sixty Ti is nice');
		const m = getVoiceRewriteMetrics();
		expect(m.invocations).toBe(1);
		expect(m.rewrites).toBe(1);
		expect(m.fallbacks).toBe(0);
	});

	it('falls back byte-identical on a timeout and counts it', async () => {
		process.env.VOICE_REWRITER_MODEL = 'test-model';
		process.env.OLLAMA_API_KEY = 'test-key';
		process.env.VOICE_REWRITER_TIMEOUT_MS = '10';
		// Never resolve until the request signal aborts, mimicking a slow model.
		vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
			const signal = (init as RequestInit | undefined)?.signal;
			return new Promise((_resolve, reject) => {
				if (signal) {
					signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				}
			});
		});
		const input = 'The RTX 5060 Ti is nice';
		const out = await rewriteForSpeech(input);
		expect(out).toBe(input);
		const m = getVoiceRewriteMetrics();
		expect(m.invocations).toBe(1);
		expect(m.timeouts).toBe(1);
		expect(m.fallbacks).toBe(1);
		expect(m.rewrites).toBe(0);
	});

	it('falls back byte-identical on a fetch error', async () => {
		process.env.VOICE_REWRITER_MODEL = 'test-model';
		process.env.OLLAMA_API_KEY = 'test-key';
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
		const input = 'The RTX 5060 Ti is nice';
		const out = await rewriteForSpeech(input);
		expect(out).toBe(input);
		const m = getVoiceRewriteMetrics();
		expect(m.timeouts).toBe(0);
		expect(m.fallbacks).toBe(1);
	});

	it('falls back on a non-ok response', async () => {
		process.env.VOICE_REWRITER_MODEL = 'test-model';
		process.env.OLLAMA_API_KEY = 'test-key';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
		const out = await rewriteForSpeech('The RTX 5060 Ti is nice');
		expect(out).toBe('The RTX 5060 Ti is nice');
		expect(getVoiceRewriteMetrics().fallbacks).toBe(1);
	});

	it('rejects a response that balloons beyond a sane length ratio', async () => {
		process.env.VOICE_REWRITER_MODEL = 'test-model';
		process.env.OLLAMA_API_KEY = 'test-key';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(chatResponse('x'.repeat(2000)));
		const out = await rewriteForSpeech('RTX 5060');
		expect(out).toBe('RTX 5060');
		expect(getVoiceRewriteMetrics().fallbacks).toBe(1);
	});

	it('falls back when a cloud endpoint has no api key', async () => {
		process.env.VOICE_REWRITER_MODEL = 'test-model';
		delete process.env.OLLAMA_API_KEY;
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const out = await rewriteForSpeech('The RTX 5060 Ti is nice');
		expect(out).toBe('The RTX 5060 Ti is nice');
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('speakableTextForSpeech (integration point)', () => {
	const originalModel = process.env.VOICE_REWRITER_MODEL;
	const originalKey = process.env.OLLAMA_API_KEY;

	beforeEach(() => {
		vi.restoreAllMocks();
		resetVoiceRewriteMetrics();
	});

	afterEach(() => {
		if (originalModel === undefined) delete process.env.VOICE_REWRITER_MODEL;
		else process.env.VOICE_REWRITER_MODEL = originalModel;
		if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
		else process.env.OLLAMA_API_KEY = originalKey;
	});

	it('is byte-identical to speakableText when the flag is off', async () => {
		delete process.env.VOICE_REWRITER_MODEL;
		const samples = [
			'The RTX 5060 Ti is in the $400-$460 range.',
			'Newegg lists the MSI 8GB version at $459.99.',
			"It's 5:02 PM on Sunday, May 31, 2026.",
			'how was your day'
		];
		for (const sample of samples) {
			expect(await speakableTextForSpeech(sample)).toBe(speakableText(sample));
		}
	});

	it('re-runs the rewriter output through the deterministic normalizer', async () => {
		process.env.VOICE_REWRITER_MODEL = 'test-model';
		process.env.OLLAMA_API_KEY = 'test-key';
		// Rewriter hands back plain text that still contains a normalizable unit;
		// speakableTextForSpeech must apply speakableText on top of it.
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(chatResponse('the card has 8 GB onboard'));
		const out = await speakableTextForSpeech('the card has 8GB onboard');
		expect(out).toBe(speakableText('the card has 8 GB onboard'));
		expect(out).toContain('<sub alias="eight gigabytes">8 GB</sub>');
	});
});
