import { beforeEach, describe, expect, it, vi } from 'vitest';

const ENV: Record<string, string | undefined> = {};
const state = vi.hoisted(() => ({
	getTodayTtsUsage: vi.fn(),
	addTtsUsage: vi.fn(),
	getVoice: vi.fn(),
	cloudAvailable: vi.fn(),
	localRefFor: vi.fn(),
	speakableText: vi.fn(),
	padWavTrailingSilence: vi.fn(),
	synthesizeLocalTts: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: ENV }));
vi.mock('$lib/server/voice_usage', () => ({
	getTodayTtsUsage: state.getTodayTtsUsage,
	addTtsUsage: state.addTtsUsage
}));
vi.mock('$lib/server/voices', () => ({
	getVoice: state.getVoice,
	cloudAvailable: state.cloudAvailable,
	localRefFor: state.localRefFor,
	DEFAULT_VOICE_ID: 'emma'
}));
vi.mock('$lib/server/tts_normalize', () => ({
	speakableText: state.speakableText
}));
vi.mock('$lib/server/wav_pad', () => ({
	padWavTrailingSilence: state.padWavTrailingSilence
}));
vi.mock('$lib/server/voice_tts', () => ({
	synthesizeLocalTts: state.synthesizeLocalTts
}));

beforeEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
	for (const key of Object.keys(ENV)) delete ENV[key];
	state.getTodayTtsUsage.mockReset();
	state.addTtsUsage.mockReset();
	state.getVoice.mockReset();
	state.cloudAvailable.mockReset();
	state.localRefFor.mockReset();
	state.speakableText.mockReset();
	state.padWavTrailingSilence.mockReset();
	state.synthesizeLocalTts.mockReset();
	state.getTodayTtsUsage.mockReturnValue(0);
	state.speakableText.mockImplementation((text: string) => text);
	state.cloudAvailable.mockReturnValue(true);
	state.getVoice.mockReturnValue({
		id: 'emma',
		engine: 'azure',
		voiceName: 'en-US-AriaNeural'
	});
});

async function loadRoute() {
	return import('../src/routes/api/chat/speak/+server');
}

describe('/api/chat/speak Azure provider', () => {
	it('sends Azure SSML with the configured neural voice and returns audio/mpeg', async () => {
		ENV.AZURE_SPEECH_KEY = 'azure-test-key';
		ENV.AZURE_SPEECH_REGION = 'westus2';
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(Uint8Array.from([1, 2, 3]), {
				status: 200,
				headers: { 'content-type': 'audio/mpeg' }
			})
		);
		vi.stubGlobal('fetch', fetchSpy);

		const { POST } = await loadRoute();
		const response = await POST({
			request: new Request('http://test.local/api/chat/speak', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: 'Hello from Sully.' })
			})
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('audio/mpeg');
		expect(state.addTtsUsage).toHaveBeenCalledWith('Hello from Sully.'.length);
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://westus2.tts.speech.microsoft.com/cognitiveservices/v1');
		expect(init.method).toBe('POST');
		expect(init.headers).toMatchObject({
			'Ocp-Apim-Subscription-Key': 'azure-test-key',
			'Content-Type': 'application/ssml+xml',
			'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
			Accept: 'audio/mpeg'
		});
		const body = String(init.body);
		expect(body).toContain('<speak');
		expect(body).toContain('xml:lang="en-US"');
		expect(body).toContain('name="en-US-AriaNeural"');
		expect(body).toContain('Hello from Sully.');
	});

	it('returns 503 when Azure creds are missing', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const { POST } = await loadRoute();

		await expect(
			POST({
				request: new Request('http://test.local/api/chat/speak', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ text: 'Hello from Sully.' })
				})
			} as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 503 });

		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
