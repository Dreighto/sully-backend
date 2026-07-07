import { beforeEach, describe, expect, it, vi } from 'vitest';

const ENV: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

beforeEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
	for (const key of Object.keys(ENV)) delete ENV[key];
	ENV.AZURE_SPEECH_KEY = 'azure-test-key';
	ENV.AZURE_SPEECH_REGION = 'westus2';
});

async function loadAzureTts() {
	return import('../src/lib/server/azure_tts');
}

describe('synthesizeAzureTts', () => {
	it('uses the standard Azure REST endpoint and plain voice SSML by default', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(Uint8Array.from([1, 2, 3]), {
				status: 200,
				headers: { 'content-type': 'audio/mpeg' }
			})
		);
		vi.stubGlobal('fetch', fetchSpy);
		const { synthesizeAzureTts } = await loadAzureTts();

		await synthesizeAzureTts({
			text: 'Hello from Sully.',
			voice: 'en-US-Ava:DragonHDLatestNeural',
			format: 'mp3'
		});

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://westus2.tts.speech.microsoft.com/cognitiveservices/v1');
		expect(String(init.body)).toContain('<voice name="en-US-Ava:DragonHDLatestNeural">');
		expect(String(init.body)).not.toContain('effect=');
	});

	it('adds the pronunciation experiment query parameter and SSML voice effect when enabled', async () => {
		ENV.AZURE_TTS_ENABLE_PRONUNCIATION_EXPERIMENT = '1';
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(Uint8Array.from([1, 2, 3]), {
				status: 200,
				headers: { 'content-type': 'audio/wav' }
			})
		);
		vi.stubGlobal('fetch', fetchSpy);
		const { synthesizeAzureTts } = await loadAzureTts();

		await synthesizeAzureTts({
			text: 'Hello from Sully.',
			voice: 'en-US-Ava:DragonHDLatestNeural',
			format: 'wav'
		});

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://westus2.tts.speech.microsoft.com/cognitiveservices/v1?effect=eq_car');
		expect(String(init.body)).toContain(
			'<voice name="en-US-Ava:DragonHDLatestNeural" effect="eq_car">'
		);
	});
});
