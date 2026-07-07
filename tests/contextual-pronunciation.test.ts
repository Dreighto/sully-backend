import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyContextualPronunciation,
	shouldApplyContextualRewrite,
	trackAEnabled
} from '../src/lib/server/contextual_pronunciation';

describe('shouldApplyContextualRewrite', () => {
	it('triggers on tech model numbers', () => {
		expect(shouldApplyContextualRewrite('The RTX 5060 Ti is nice')).toBe(true);
		expect(shouldApplyContextualRewrite('iPhone 15 Pro Max')).toBe(true);
		expect(shouldApplyContextualRewrite('Ryzen 9 7950X details')).toBe(true);
	});

	it('triggers on standalone acronyms', () => {
		expect(shouldApplyContextualRewrite('I need a new GPU today')).toBe(true);
		expect(shouldApplyContextualRewrite('Any SSD recommendations')).toBe(true);
	});

	it('skips plain conversational text', () => {
		expect(shouldApplyContextualRewrite('How was your day')).toBe(false);
		expect(shouldApplyContextualRewrite('The weather is fine right now')).toBe(false);
	});

	it('skips oversize inputs', () => {
		const long = 'RTX 5060 '.repeat(60);
		expect(shouldApplyContextualRewrite(long)).toBe(false);
	});
});

describe('trackAEnabled', () => {
	const original = process.env.TRACK_A_ENABLED;
	afterEach(() => {
		if (original === undefined) delete process.env.TRACK_A_ENABLED;
		else process.env.TRACK_A_ENABLED = original;
	});

	it('defaults off', () => {
		delete process.env.TRACK_A_ENABLED;
		expect(trackAEnabled()).toBe(false);
	});

	it('turns on when env is 1', () => {
		process.env.TRACK_A_ENABLED = '1';
		expect(trackAEnabled()).toBe(true);
	});
});

describe('applyContextualPronunciation', () => {
	const originalEnabled = process.env.TRACK_A_ENABLED;
	const originalKey = process.env.OLLAMA_API_KEY;

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		if (originalEnabled === undefined) delete process.env.TRACK_A_ENABLED;
		else process.env.TRACK_A_ENABLED = originalEnabled;
		if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
		else process.env.OLLAMA_API_KEY = originalKey;
	});

	it('returns text unchanged when flag off', async () => {
		delete process.env.TRACK_A_ENABLED;
		const out = await applyContextualPronunciation('The RTX 5060 Ti is nice');
		expect(out).toBe('The RTX 5060 Ti is nice');
	});

	it('returns text unchanged when input does not need rewriting', async () => {
		process.env.TRACK_A_ENABLED = '1';
		process.env.OLLAMA_API_KEY = 'test-key';
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const out = await applyContextualPronunciation('How was your day');
		expect(out).toBe('How was your day');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('falls back to raw text on fetch failure', async () => {
		process.env.TRACK_A_ENABLED = '1';
		process.env.OLLAMA_API_KEY = 'test-key';
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
		const out = await applyContextualPronunciation('The RTX 5060 Ti is nice');
		expect(out).toBe('The RTX 5060 Ti is nice');
	});

	it('falls back to raw text on non-ok response', async () => {
		process.env.TRACK_A_ENABLED = '1';
		process.env.OLLAMA_API_KEY = 'test-key';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
		const out = await applyContextualPronunciation('The RTX 5060 Ti is nice');
		expect(out).toBe('The RTX 5060 Ti is nice');
	});

	it('returns the rewritten string when the LLM answers', async () => {
		process.env.TRACK_A_ENABLED = '1';
		process.env.OLLAMA_API_KEY = 'test-key';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					message: {
						content:
							'The <say-as interpret-as="characters">RTX</say-as> <say-as interpret-as="cardinal">5060</say-as> Ti is nice'
					}
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		);
		const out = await applyContextualPronunciation('The RTX 5060 Ti is nice');
		expect(out).toContain('<say-as');
		expect(out).toContain('RTX');
	});

	it('rejects a response that balloons beyond a sane length ratio', async () => {
		process.env.TRACK_A_ENABLED = '1';
		process.env.OLLAMA_API_KEY = 'test-key';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ message: { content: 'x'.repeat(2000) } }), { status: 200 })
		);
		const out = await applyContextualPronunciation('RTX 5060');
		expect(out).toBe('RTX 5060');
	});
});
