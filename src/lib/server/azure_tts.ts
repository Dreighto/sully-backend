// Shared Azure Speech synthesis core. Used by both the Talkback read-aloud
// route (/api/chat/speak, MP3) and Voice Mode's real-time per-sentence
// streaming (chat/voice_stream.ts, WAV/PCM — matches the Kokoro contract it
// replaced, so the iOS client's audio decoding needs no changes).
import { env } from '$env/dynamic/private';
import { Agent } from 'undici';

// Keep-alive dispatcher for the Azure TTS endpoint. Without it every
// per-sentence synth call pays a fresh TCP + TLS handshake to the Azure
// region, which sits directly on the time-to-first-audio critical path
// (operator finding, build 193: 3-4s perceived latency).
const azureDispatcher = new Agent({
	keepAliveTimeout: 60_000,
	keepAliveMaxTimeout: 120_000,
	connections: 4
});

let lastPrewarmAt = 0;

/**
 * Fire-and-forget TLS pre-warm against the Azure voices endpoint so the first
 * real synth call of a voice session reuses a hot connection. Called from
 * voice-config (fires when the operator opens Voice Mode, seconds before the
 * first turn). Throttled to once per 60s.
 */
export function prewarmAzureTts(): void {
	const apiKey = env.AZURE_SPEECH_KEY;
	const region = env.AZURE_SPEECH_REGION;
	if (!apiKey || !region) return;
	const now = Date.now();
	if (now - lastPrewarmAt < 60_000) return;
	lastPrewarmAt = now;
	fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
		headers: { 'Ocp-Apim-Subscription-Key': apiKey },
		// @ts-expect-error undici dispatcher is a Node extension to fetch
		dispatcher: azureDispatcher
	}).catch(() => {
		lastPrewarmAt = 0;
	});
}

// Ava DragonHD: Azure's newest generative voice tier. More natural cadence
// and expressiveness than the standard Neural voices (AriaNeural was the
// prior default). Live-verified against both MP3 (Talkback route) and WAV
// (Voice Mode streaming) output formats on 2026-07-06.
export const DEFAULT_AZURE_VOICE = 'en-US-Ava:DragonHDLatestNeural';

export type AzureOutputFormat = 'mp3' | 'wav';

const OUTPUT_FORMAT_HEADERS: Record<AzureOutputFormat, { format: string; accept: string }> = {
	mp3: { format: 'audio-24khz-48kbitrate-mono-mp3', accept: 'audio/mpeg' },
	wav: { format: 'riff-24khz-16bit-mono-pcm', accept: 'audio/wav' }
};

function escapeSsml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

export function azureConfigured(): boolean {
	return !!env.AZURE_SPEECH_KEY && !!env.AZURE_SPEECH_REGION;
}

/**
 * Synthesize `text` via Azure Speech's SSML endpoint. Returns the raw fetch
 * Response (caller decides whether to stream `.body` or buffer `.arrayBuffer()`).
 * Throws on missing credentials or a non-2xx Azure response — callers propagate
 * that as their own error path (matches the pre-existing Kokoro/ElevenLabs
 * synth() contract of throwing on transport/HTTP failure).
 */
export async function synthesizeAzureTts(opts: {
	text: string;
	voice?: string;
	format?: AzureOutputFormat;
	signal?: AbortSignal;
	ssml?: boolean;
}): Promise<Response> {
	const apiKey = env.AZURE_SPEECH_KEY;
	const region = env.AZURE_SPEECH_REGION;
	if (!apiKey || !region) {
		throw new Error('Azure Speech not configured (AZURE_SPEECH_KEY/AZURE_SPEECH_REGION missing)');
	}
	const voiceName = opts.voice ?? DEFAULT_AZURE_VOICE;
	const { format, accept } = OUTPUT_FORMAT_HEADERS[opts.format ?? 'mp3'];
	const voiceBody = opts.ssml ? opts.text : escapeSsml(opts.text);
	const ssml = [
		'<speak version="1.0" xml:lang="en-US">',
		`<voice name="${escapeSsml(voiceName)}">`,
		voiceBody,
		'</voice>',
		'</speak>'
	].join('');

	const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
		method: 'POST',
		headers: {
			'Ocp-Apim-Subscription-Key': apiKey,
			'Content-Type': 'application/ssml+xml',
			'X-Microsoft-OutputFormat': format,
			Accept: accept
		},
		body: ssml,
		signal: opts.signal,
		// @ts-expect-error undici dispatcher is a Node extension to fetch
		dispatcher: azureDispatcher
	});
	if (!res.ok) {
		const errBody = await res.text().catch(() => '');
		throw new Error(`Azure Speech TTS HTTP ${res.status}: ${errBody}`);
	}
	return res;
}
