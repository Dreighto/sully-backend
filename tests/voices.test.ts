// Lock the voice catalog: the resolution layer that lets Sully hold multiple
// switchable voices (Emma cloud, Goodman-Sulley local) while keeping filesystem
// paths and provider ids server-side.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ENV: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

beforeEach(() => {
	vi.resetModules();
	for (const k of Object.keys(ENV)) delete ENV[k];
});

async function load() {
	return import('../src/lib/server/voices');
}

describe('voice catalog', () => {
	it('getVoice falls back to the default (emma) on unknown/empty id', async () => {
		const { getVoice, DEFAULT_VOICE_ID } = await load();
		expect(DEFAULT_VOICE_ID).toBe('emma');
		expect(getVoice('does-not-exist').id).toBe('emma');
		expect(getVoice(null).id).toBe('emma');
		expect(getVoice(undefined).id).toBe('emma');
		expect(getVoice('goodman-sully').id).toBe('goodman-sully');
	});

	it('clientVoices exposes ≥2 voices and never leaks paths or provider ids', async () => {
		const { clientVoices } = await load();
		const list = clientVoices();
		expect(list.length).toBeGreaterThanOrEqual(2);
		const json = JSON.stringify(list);
		expect(json).not.toMatch(/\//); // no filesystem paths
		expect(json).not.toMatch(/56bWUR/); // no ElevenLabs voice id
		for (const v of list) {
			expect(v).toHaveProperty('label');
			expect(v).toHaveProperty('blurb');
			expect(v).toHaveProperty('engine');
		}
	});

	it('cloudAvailable requires a key and honors the VOICE_TTS_PROVIDER=local override', async () => {
		const m = await load();
		expect(m.cloudAvailable()).toBe(false); // no key
		ENV.ELEVENLABS_API_KEY = 'xi-test';
		expect(m.cloudAvailable()).toBe(true);
		ENV.VOICE_TTS_PROVIDER = 'local'; // master force-local override
		expect(m.cloudAvailable()).toBe(false);
		ENV.VOICE_TTS_PROVIDER = 'elevenlabs';
		expect(m.cloudAvailable()).toBe(true);
	});

	it('routingFor: cloud voice → speak (+ local fallback) with a key; local voice always → speak-local', async () => {
		ENV.ELEVENLABS_API_KEY = 'xi-test';
		const m = await load();
		expect(m.routingFor(m.getVoice('emma'))).toEqual({
			ttsPath: '/api/chat/speak',
			ttsModel: 'eleven_flash_v2_5',
			ttsFallbackPath: '/api/chat/speak-local'
		});
		expect(m.routingFor(m.getVoice('goodman-sully'))).toEqual({
			ttsPath: '/api/chat/speak-local',
			ttsModel: undefined,
			ttsFallbackPath: undefined
		});
		// A cloud voice degrades to local synthesis when cloud is unavailable.
		delete ENV.ELEVENLABS_API_KEY;
		expect(m.routingFor(m.getVoice('emma')).ttsPath).toBe('/api/chat/speak-local');
	});

	it('localRefFor: cloud voice uses its Chatterbox clone fallback; Kokoro voice returns undefined', async () => {
		const m = await load();
		// goodman-sully is now a Kokoro voice — no Chatterbox ref
		expect(m.localRefFor(m.getVoice('goodman-sully'))).toBeUndefined();
		expect(m.localRefFor(m.getVoice('emma'))).toMatch(/emma\.mp3$/);
	});

	it('kokoroVoiceFor: Kokoro voice uses its own id; cloud voice uses its Kokoro fallback id', async () => {
		const m = await load();
		expect(m.kokoroVoiceFor(m.getVoice('goodman-sully'))).toBe('am_fenrir');
		expect(m.kokoroVoiceFor(m.getVoice('emma'))).toBe('bf_emma');
		expect(m.kokoroVoiceFor(m.getVoice('lewis'))).toBe('bm_lewis');
	});
});
