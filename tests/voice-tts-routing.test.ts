// Lock the /api/chat/voice-config contract. It resolves TTS routing from the
// ACTIVE voice (persisted in companion_settings; default = emma) plus whether
// cloud (Azure Speech) is available. The realtime controller consumes
// voice/voices/ttsPath/ttsModel/ttsFallbackPath; if this drifts, voice mode
// speaks in the wrong voice (or none). The DB path is pointed at a nonexistent
// file so getSetting() returns null → default voice, with no DB side effects.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ENV: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

const BASE: Record<string, string> = {
	LOGUEOS_APP_MODE: 'companion',
	LOGUEOS_MEMORY_DB_PATH: '/tmp/nonexistent-companion-voice-test.db',
	COMPANION_DEFAULT_MODEL: 'companion-v1:latest',
	OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
	LOGUEOS_RUN_POLL_MS: '5000',
	LOGUEOS_RUN_FEED_LIMIT: '50',
	ANTHROPIC_DAILY_TOKEN_CAP: '1000000',
	OPENAI_DAILY_TOKEN_CAP: '200000',
	GEMINI_DAILY_TOKEN_CAP: '2000000'
};

beforeEach(() => {
	vi.resetModules();
	for (const k of Object.keys(ENV)) delete ENV[k];
	Object.assign(ENV, BASE);
});

async function getConfig(): Promise<Record<string, unknown>> {
	const { GET } = await import('../src/routes/api/chat/voice-config/+server');
	const res = await (GET as unknown as (e: unknown) => Promise<Response>)({});
	return res.json();
}

describe('voice-config', () => {
	it('default active voice is Emma via Azure Speech + local fallback when creds are present', async () => {
		ENV.AZURE_SPEECH_KEY = 'azure-test-key';
		ENV.AZURE_SPEECH_REGION = 'westus2';
		const cfg = await getConfig();
		expect(cfg.voice).toBe('emma');
		expect(cfg.ttsPath).toBe('/api/chat/speak');
		expect(cfg.ttsModel).toBe('en-US-AriaNeural');
		expect(cfg.ttsFallbackPath).toBe('/api/chat/speak-local');
	});

	it('exposes the switchable voice list (Emma + Goodman-Sulley + Lewis), no leaked paths', async () => {
		ENV.AZURE_SPEECH_KEY = 'azure-test-key';
		ENV.AZURE_SPEECH_REGION = 'westus2';
		const cfg = await getConfig();
		const voices = cfg.voices as Array<{ id: string }>;
		const ids = voices.map((v) => v.id).sort();
		expect(ids).toEqual(['emma', 'goodman-sully', 'lewis']);
		expect(JSON.stringify(voices)).not.toMatch(/\//);
	});

	it('degrades to local Chatterbox when Azure creds are missing', async () => {
		const cfg = await getConfig(); // no key
		expect(cfg.voice).toBe('emma');
		expect(cfg.ttsPath).toBe('/api/chat/speak-local');
		expect(cfg.ttsModel).toBeUndefined();
		expect(cfg.ttsFallbackPath).toBeUndefined();
	});

	it('VOICE_TTS_PROVIDER=local forces everything local even with a key', async () => {
		ENV.AZURE_SPEECH_KEY = 'azure-test-key';
		ENV.AZURE_SPEECH_REGION = 'westus2';
		ENV.VOICE_TTS_PROVIDER = 'local';
		const cfg = await getConfig();
		expect(cfg.ttsPath).toBe('/api/chat/speak-local');
	});

	it('always exposes the STT socket path + hands-free defaults', async () => {
		ENV.AZURE_SPEECH_KEY = 'azure-test-key';
		ENV.AZURE_SPEECH_REGION = 'westus2';
		const cfg = await getConfig();
		expect(cfg.voiceEnabled).toBe(true);
		expect(cfg.wsPath).toBe('/companion-voice');
		expect(cfg.continuousDefault).toBe(true);
	});
});
