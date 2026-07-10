import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runVoiceStreamingSpeak } from '$lib/server/chat/voice_stream';

vi.mock('$lib/server/azure_tts', () => ({
	synthesizeAzureTts: vi.fn().mockResolvedValue(new Response(Buffer.from('RIFF'))),
	DEFAULT_AZURE_VOICE: 'en-US-Ava:DragonHDLatestNeural',
	// W4-B fallback exports voice_stream now imports; breaker closed so these
	// filler-path turns stay on Azure and never fall forward.
	azureBreakerOpen: () => false,
	recordAzureFailure: vi.fn(),
	recordAzureSuccess: vi.fn()
}));

vi.mock('$lib/server/chat/web_search', () => ({
	OLLAMA_API_KEY: 'test-key'
}));

vi.mock('$lib/server/voice_runtime', () => ({
	VOICE_OLLAMA_URL: 'http://jetson.test',
	// voice_stream now imports voice_tts → voice_services, which resolves the TTS
	// URL at module load. Unused here (no fall-forward), but needed to load.
	resolveTtsUrl: () => 'http://jetson.test'
}));

vi.mock('$lib/server/chat/voice_tools', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/chat/voice_tools')>();
	return {
		...actual,
		runVoiceToolLoop: vi.fn(async (args: Parameters<typeof actual.runVoiceToolLoop>[0]) => {
			args.onToolStart?.('web_search');
			return { content: 'Real answer here.', toolsUsed: ['web_search'] };
		})
	};
});

const fetchMock = vi.fn();

function ndjsonLine(obj: unknown) {
	return `${JSON.stringify(obj)}\n`;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('runVoiceStreamingSpeak — filler caption contract', () => {
	it('marks filler sentences and excludes them from done.transcript', async () => {
		const toolTurnLine = ndjsonLine({
			message: { content: '', tool_calls: [{ function: { name: 'web_search', arguments: {} } }] }
		});
		const encoder = new TextEncoder();
		const chunks: string[] = [];
		const controller = {
			enqueue(chunk: Uint8Array) {
				chunks.push(new TextDecoder().decode(chunk));
			}
		} as ReadableStreamDefaultController<Uint8Array>;

		fetchMock.mockResolvedValue({
			ok: true,
			body: {
				getReader: () => {
					let sent = false;
					return {
						async read() {
							if (!sent) {
								sent = true;
								return { value: encoder.encode(toolTurnLine), done: false };
							}
							return { value: undefined, done: true };
						},
						cancel: async () => {}
					};
				}
			}
		});

		await runVoiceStreamingSpeak(
			{
				model: 'test-voice',
				messages: [{ role: 'user', content: 'search something' }],
				keepAlive: '10m',
				numCtx: 4096
			},
			controller,
			encoder
		);

		const sse = chunks.join('');
		const sentenceEvents = [...sse.matchAll(/event: sentence\ndata: ([^\n]+)/g)].map((m) =>
			JSON.parse(m[1])
		);
		const doneMatch = sse.match(/event: done\ndata: ([^\n]+)/);
		expect(doneMatch).toBeTruthy();
		const done = JSON.parse(doneMatch![1]);

		expect(sentenceEvents.some((e) => e.filler === true)).toBe(true);
		expect(sentenceEvents.some((e) => e.text === 'Real answer here.')).toBe(true);
		const nonFiller = sentenceEvents.filter((e) => !e.filler).map((e) => e.text);
		expect(done.transcript).toBe(nonFiller.join(' '));
		expect(done.transcript).toBe('Real answer here.');
		expect(done.transcript).not.toContain('Checking.');
	});
});
