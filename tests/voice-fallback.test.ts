// SUL-195 / W4-B: Azure-unreachable fallback for streaming Voice Mode.
//
// Exercises the fallback ladder in runVoiceStreamingSpeak end-to-end by mocking
// BOTH synth engines (Azure via azure_tts, Kokoro via voice_tts) and feeding a
// canned Ollama NDJSON stream through a stubbed global fetch. We assert on the
// SSE events written to a fake controller and on the returned VoiceStreamResult.
//
// The circuit breaker is the REAL module-level state (we spread importActual and
// only override synthesizeAzureTts), so voice_stream and voice-config observe the
// same breaker, reset before each case.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks -----------------------------------------------------------------
// Override only the two synth entry points; keep the real breaker + constants.
// Hoisted so the (hoisted) vi.mock factories can reference the spies.
const { azureSynth, localSynth } = vi.hoisted(() => ({
	azureSynth: vi.fn(),
	localSynth: vi.fn()
}));
vi.mock('$lib/server/azure_tts', async (importActual) => {
	const actual = await importActual<typeof import('$lib/server/azure_tts')>();
	return { ...actual, synthesizeAzureTts: azureSynth };
});

vi.mock('$lib/server/voice_tts', async (importActual) => {
	const actual = await importActual<typeof import('$lib/server/voice_tts')>();
	return { ...actual, synthesizeLocalTts: localSynth };
});

// Keep the voice-config route off the settings DB; it only needs a voice id.
vi.mock('$lib/server/settings', () => ({ getSetting: () => null }));

import { runVoiceStreamingSpeak } from '$lib/server/chat/voice_stream';
import { azureBreakerState, recordAzureFailure, __resetAzureBreaker } from '$lib/server/azure_tts';
import { GET as voiceConfigGet } from '../src/routes/api/chat/voice-config/+server';

// --- Fakes -----------------------------------------------------------------

// A minimal RIFF/WAVE buffer so normalizeWavPeak passes it through untouched
// (it returns non-WAV input unchanged too, but a real header keeps intent clear).
function wavBytes(): ArrayBuffer {
	const b = Buffer.alloc(44);
	b.write('RIFF', 0, 'ascii');
	b.writeUInt32LE(36, 4);
	b.write('WAVE', 8, 'ascii');
	b.write('fmt ', 12, 'ascii');
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20); // PCM
	b.writeUInt16LE(1, 22); // mono
	b.writeUInt32LE(24000, 24);
	b.writeUInt16LE(16, 34); // bits
	b.write('data', 36, 'ascii');
	b.writeUInt32LE(0, 40);
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// Azure returns an object exposing arrayBuffer() (like the fetch Response the
// real synthesizeAzureTts hands back).
function azureOk() {
	return { arrayBuffer: async () => wavBytes() };
}

// Kokoro returns a Response-shaped object (ok + a readable body).
function kokoroOk() {
	return {
		ok: true,
		status: 200,
		body: new ReadableStream({
			start(c) {
				c.close();
			}
		}),
		arrayBuffer: async () => wavBytes()
	};
}
function kokoroDown() {
	return { ok: false, status: 502, body: null, arrayBuffer: async () => new ArrayBuffer(0) };
}

// A canned Ollama /api/chat NDJSON stream: one content chunk per sentence, then
// a terminating done line. Stubbed onto global fetch (undici-backed Azure calls
// go through the mock, so only Ollama hits this).
function stubOllama(...sentences: string[]) {
	const enc = new TextEncoder();
	const lines = sentences.map((s) => JSON.stringify({ message: { content: s } }) + '\n');
	lines.push(
		JSON.stringify({ done: true, prompt_eval_count: 3, prompt_eval_duration: 1_000_000 }) + '\n'
	);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			const body = new ReadableStream({
				start(c) {
					for (const l of lines) c.enqueue(enc.encode(l));
					c.close();
				}
			});
			return new Response(body, { status: 200 });
		})
	);
}

// Collect SSE events written to the controller.
function makeSink() {
	const dec = new TextDecoder();
	let raw = '';
	const controller = {
		enqueue: (u8: Uint8Array) => {
			raw += dec.decode(u8);
		},
		close: () => {},
		error: () => {}
	} as unknown as ReadableStreamDefaultController<Uint8Array>;
	function events() {
		return raw
			.split('\n\n')
			.map((block) => block.trim())
			.filter((b) => b && !b.startsWith(':')) // drop heartbeat comments
			.map((block) => {
				const ev = /event: (.*)/.exec(block)?.[1] ?? '';
				const dataLine = /data: (.*)/.exec(block)?.[1];
				return { event: ev, data: dataLine ? JSON.parse(dataLine) : null };
			})
			.filter((e) => e.event);
	}
	return { controller, events };
}

async function run() {
	const { controller, events } = makeSink();
	const res = await runVoiceStreamingSpeak(
		{
			model: 'companion-v1-voice:latest',
			messages: [{ role: 'user', content: 'hi' }],
			keepAlive: '5m',
			numCtx: 4096
		},
		controller,
		new TextEncoder()
	);
	return { res, events: events() };
}

// --- Cases -----------------------------------------------------------------

beforeEach(() => {
	__resetAzureBreaker();
	azureSynth.mockReset();
	localSynth.mockReset();
	vi.unstubAllGlobals();
});

describe('W4-B voice fallback ladder', () => {
	it('Azure fails once then succeeds on retry, no fallback, no notice', async () => {
		stubOllama('Only one sentence.');
		azureSynth.mockRejectedValueOnce(new Error('azure blip')).mockResolvedValue(azureOk());

		const { res, events } = await run();

		// One immediate retry, then Azure succeeds: two Azure calls, no Kokoro.
		expect(azureSynth).toHaveBeenCalledTimes(2);
		expect(localSynth).not.toHaveBeenCalled();
		expect(events.find((e) => e.event === 'notice')).toBeUndefined();
		expect(events.some((e) => e.event === 'audio')).toBe(true);
		expect(res.hardFailed).toBeFalsy();
		// A success closes/keeps-closed the breaker.
		expect(azureBreakerState().open).toBe(false);
	});

	it('Azure fails twice, falls forward to Kokoro and emits the notice exactly once', async () => {
		stubOllama('First sentence here. ', 'Second sentence here.');
		azureSynth.mockRejectedValue(new Error('azure down'));
		localSynth.mockResolvedValue(kokoroOk());

		const { res, events } = await run();

		// Sentence 1: Azure x2 (both fail) → Kokoro. Sentence 2: turn already fell
		// forward → straight to Kokoro (no further Azure attempts).
		expect(azureSynth).toHaveBeenCalledTimes(2);
		expect(localSynth).toHaveBeenCalledTimes(2);
		const notices = events.filter((e) => e.event === 'notice');
		expect(notices).toHaveLength(1);
		expect(notices[0].data.text).toBe('Speaking with the backup voice for now');
		expect(notices[0].data.reason).toBe('azure_failure');
		expect(res.hardFailed).toBeFalsy();
	});

	it('breaker opens after 3 Azure failures then routes straight to Kokoro (no Azure attempt)', async () => {
		// Three single-sentence turns, Azure always failing, Kokoro healthy.
		azureSynth.mockRejectedValue(new Error('azure down'));
		localSynth.mockResolvedValue(kokoroOk());

		for (let i = 0; i < 3; i++) {
			stubOllama(`Turn ${i} sentence.`);
			await run();
		}
		// After 3 consecutive failures the breaker is open.
		expect(azureBreakerState().open).toBe(true);
		expect(azureBreakerState().reason).toMatch(/backup voice/i);

		// Next turn: breaker open → Azure is NOT called at all, Kokoro serves it,
		// and the breaker-open notice fires.
		azureSynth.mockClear();
		localSynth.mockClear();
		stubOllama('Post-open sentence.');
		const { events } = await run();
		expect(azureSynth).not.toHaveBeenCalled();
		expect(localSynth).toHaveBeenCalledTimes(1);
		const notice = events.find((e) => e.event === 'notice');
		expect(notice?.data.reason).toBe('breaker_open');
	});

	it('breaker closes on a successful Azure synth after the cool-down elapses', async () => {
		// Open the breaker (3 failures), then let the cool-down pass via fake timers
		// and prove a subsequent Azure success closes it.
		azureSynth.mockRejectedValue(new Error('azure down'));
		localSynth.mockResolvedValue(kokoroOk());
		for (let i = 0; i < 3; i++) {
			stubOllama(`Fail turn ${i}.`);
			await run();
		}
		expect(azureBreakerState().open).toBe(true);

		// Advance the clock past the 5-minute default cool-down and run the probe
		// turn WHILE fake timers hold, reverting first would restore the old clock
		// and re-close the cool-down window. The stream/synth mocks resolve on
		// microtasks, so the turn still completes under fake timers.
		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.now() + 6 * 60 * 1000);
			// Cool-down elapsed → breaker half-open, next turn probes Azure.
			expect(azureBreakerState().open).toBe(false);

			azureSynth.mockReset();
			azureSynth.mockResolvedValue(azureOk());
			localSynth.mockClear();
			stubOllama('Recovery sentence.');
			const { events } = await run();
			// Azure probed and succeeded → Kokoro untouched, breaker fully closed.
			expect(azureSynth).toHaveBeenCalledTimes(1);
			expect(localSynth).not.toHaveBeenCalled();
			expect(events.find((e) => e.event === 'notice')).toBeUndefined();
			expect(azureBreakerState().open).toBe(false);
			expect(azureBreakerState().consecutiveFailures).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('voice-config reflects breaker state honestly (closed → open)', async () => {
		// Healthy: no fallback advertised.
		const healthy = await (await voiceConfigGet({} as never)).json();
		expect(healthy.fallbackActive).toBe(false);
		expect(healthy.fallbackReason).toBeNull();

		// Open the breaker (default threshold 3) and re-read the config.
		recordAzureFailure();
		recordAzureFailure();
		recordAzureFailure();
		expect(azureBreakerState().open).toBe(true);

		const degraded = await (await voiceConfigGet({} as never)).json();
		expect(degraded.fallbackActive).toBe(true);
		expect(degraded.fallbackReason).toMatch(/backup voice/i);
	});

	it('both engines down, turn hard-fails text-only (heard prefix available), never hangs', async () => {
		stubOllama('This will not be heard.');
		azureSynth.mockRejectedValue(new Error('azure down'));
		localSynth.mockResolvedValue(kokoroDown());

		const { res, events } = await run();

		expect(res.hardFailed).toBe(true);
		expect(res.error).toMatch(/both failed/i);
		// The generated text is still returned so the caller persists a heard
		// prefix (text-only) instead of dropping the turn.
		expect(res.transcript).toContain('This will not be heard');
		// No `done` on a hard-failed turn; the fall-forward notice still fired.
		expect(events.find((e) => e.event === 'done')).toBeUndefined();
		expect(events.some((e) => e.event === 'notice')).toBe(true);
	});
});
