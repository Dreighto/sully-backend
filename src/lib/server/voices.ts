// Voice catalog for Sully. Each voice is a (engine + params) pair the TTS
// endpoints resolve SERVER-SIDE from an opaque `id`, so reference-clip
// filesystem paths and cloud-provider voice ids never reach the browser.
//
// Two voices today:
//   • emma         — Azure Speech (cloud, instant, crispest). Falls back to
//                    Kokoro (bf_emma) when cloud is capped/offline.
//   • goodman-sully — Kokoro local voice on the Jetson. Operator picks the
//                    Kokoro voice id via TTS_VOICE env on the Jetson, or set
//                    kokoroVoice here. Testing in progress.
//
// Add a voice by adding an entry with engine='kokoro' and a kokoroVoice id.
// Active voices: am_fenrir (Sulley), bf_isabella (Emma fallback), bm_lewis (Lewis)

import { env } from '$env/dynamic/private';

export type VoiceEngine = 'azure' | 'chatterbox' | 'kokoro';

export interface VoiceDef {
	id: string;
	label: string;
	blurb: string;
	engine: VoiceEngine;
	/** Cloud TTS voice id/name (engine='azure'). */
	voiceId?: string;
	/** Cloud TTS model/voice selector echoed to the client for routing metadata. */
	model?: string;
	/** Chatterbox reference clip, absolute server-side path (engine='chatterbox'). */
	voiceRef?: string;
	/** Chatterbox reference used when a CLOUD voice degrades to local synthesis. */
	fallbackVoiceRef?: string;
	/** Chatterbox synthesis knobs (see tts_server.py for defaults). */
	cfgWeight?: number;
	exaggeration?: number;
	temperature?: number;
	/** Kokoro voice id (engine='kokoro', e.g. 'af_heart', 'bf_emma'). */
	kokoroVoice?: string;
	/** Kokoro voice used when a CLOUD voice falls back to local Kokoro synthesis. */
	kokoroFallbackVoice?: string;
	/** Kokoro playback speed multiplier (default 1.0). */
	kokoroSpeed?: number;
}

/** Client-safe view of a voice — no filesystem paths, no provider ids. */
export interface VoiceOption {
	id: string;
	label: string;
	blurb: string;
	engine: VoiceEngine;
}

export interface VoiceRouting {
	ttsPath: string;
	ttsModel?: string;
	ttsFallbackPath?: string;
}

const VOICES_DIR = (
	env.COMPANION_VOICES_DIR || '/home/dreighto/dev/companion-speech/voices'
).replace(/\/+$/, '');

export const VOICES: VoiceDef[] = [
	{
		id: 'emma',
		label: 'Emma',
		blurb: 'Warm & natural — cloud, instant',
		engine: 'azure',
		voiceId: 'en-US-AriaNeural',
		model: 'en-US-AriaNeural',
		kokoroFallbackVoice: 'bf_emma',
		fallbackVoiceRef: `${VOICES_DIR}/emma.mp3`
	},
	{
		id: 'goodman-sully',
		label: 'Sulley',
		blurb: 'Big & gravelly — local (Jetson)',
		engine: 'kokoro',
		kokoroVoice: 'am_fenrir'
	},
	{
		id: 'lewis',
		label: 'Lewis',
		blurb: 'British — local (Jetson)',
		engine: 'kokoro',
		kokoroVoice: 'bm_lewis'
	}
];

export const DEFAULT_VOICE_ID = 'emma';

// The Kokoro voice used whenever no specific voice is resolved (TalkBack sends
// no voice; Voice Mode's streaming fallback). Operator picked Emma = Kokoro
// bf_emma (2026-07-05) — keep this in sync with the 'emma' voice's local fallback.
export const DEFAULT_KOKORO_VOICE = 'bf_emma';

export function getVoice(id: string | null | undefined): VoiceDef {
	return VOICES.find((v) => v.id === id) ?? VOICES.find((v) => v.id === DEFAULT_VOICE_ID)!;
}

export function clientVoices(): VoiceOption[] {
	return VOICES.map(({ id, label, blurb, engine }) => ({ id, label, blurb, engine }));
}

// Cloud TTS is usable only when Azure creds are present AND not force-local.
// `VOICE_TTS_PROVIDER=local` is a master override that pins everything local
// (Emma then speaks through her local clone) — the operator's one-flip "go fully
// local" switch.
export function cloudAvailable(): boolean {
	const forceLocal = (env.VOICE_TTS_PROVIDER || '').toLowerCase() === 'local';
	return !!env.AZURE_SPEECH_KEY && !!env.AZURE_SPEECH_REGION && !forceLocal;
}

// The Chatterbox reference path to use when synthesizing a voice LOCALLY: a
// local voice uses its own ref; a cloud voice uses its local-clone fallback ref.
export function localRefFor(v: VoiceDef): string | undefined {
	return v.voiceRef ?? v.fallbackVoiceRef;
}

// The Kokoro voice id to use when synthesizing locally via the Kokoro server:
// a Kokoro voice uses its own id; a cloud voice uses its Kokoro fallback id.
export function kokoroVoiceFor(v: VoiceDef): string | undefined {
	return v.kokoroVoice ?? v.kokoroFallbackVoice;
}

// Routing the client uses to reach the right TTS engine for a voice. A cloud
// voice routes to /api/chat/speak (with a local fall-forward); a local voice
// (or a cloud voice when cloud is unavailable) routes straight to speak-local.
export function routingFor(v: VoiceDef): VoiceRouting {
	if (v.engine === 'azure' && cloudAvailable()) {
		const hasLocalFallback = !!(v.kokoroFallbackVoice || v.fallbackVoiceRef);
		return {
			ttsPath: '/api/chat/speak',
			ttsModel: v.model,
			ttsFallbackPath: hasLocalFallback ? '/api/chat/speak-local' : undefined
		};
	}
	// 'chatterbox' and 'kokoro' engines both route through speak-local
	return { ttsPath: '/api/chat/speak-local', ttsModel: undefined, ttsFallbackPath: undefined };
}
