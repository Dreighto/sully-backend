// Voice catalog for Sully. Each voice is a (engine + params) pair the TTS
// endpoints resolve SERVER-SIDE from an opaque `id`, so reference-clip
// filesystem paths and ElevenLabs voice ids never reach the browser.
//
// Two voices today:
//   • emma         — ElevenLabs Flash (cloud, instant, crispest). Its local
//                    Chatterbox clone (emma.mp3) is the fall-forward voice when
//                    the cloud is capped/offline.
//   • goodman-sully — local Chatterbox clone of John Goodman's Sulley (private
//                    personal use). Local-only — ElevenLabs won't clone it.
//
// Add a voice by dropping a clean ~6-12s reference clip in COMPANION_VOICES_DIR
// and adding an entry here.

import { env } from '$env/dynamic/private';

export type VoiceEngine = 'elevenlabs' | 'chatterbox';

export interface VoiceDef {
	id: string;
	label: string;
	blurb: string;
	engine: VoiceEngine;
	/** ElevenLabs voice id (engine='elevenlabs'). */
	voiceId?: string;
	/** ElevenLabs model id (engine='elevenlabs'). */
	model?: string;
	/** Chatterbox reference clip, absolute server-side path (engine='chatterbox'). */
	voiceRef?: string;
	/** Chatterbox reference used when a CLOUD voice degrades to local synthesis. */
	fallbackVoiceRef?: string;
	/**
	 * Optional Chatterbox synthesis knobs. cfg_weight 0.5 (default) follows the
	 * reference's pacing rigidly — drop to ~0.3 for natural cadence when the ref
	 * is short or stitched; 0.7 to lock voice character harder. exaggeration 0.5
	 * neutral; bump for more expressive delivery. temperature 0.8 default.
	 */
	cfgWeight?: number;
	exaggeration?: number;
	temperature?: number;
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
		engine: 'elevenlabs',
		voiceId: '56bWURjYFHyYyVf490Dp',
		model: 'eleven_flash_v2_5',
		fallbackVoiceRef: `${VOICES_DIR}/emma.mp3`
	},
	{
		id: 'goodman-sully',
		label: 'Sulley',
		blurb: 'Big & gravelly (Goodman) — local',
		engine: 'chatterbox',
		voiceRef: `${VOICES_DIR}/sully_goodman.wav`,
		// Natural cadence (0.5 default makes it follow the ref pacing too rigidly
		// → "slow and weird"); slight expressiveness bump to keep Goodman's warmth.
		cfgWeight: 0.3,
		exaggeration: 0.6
	}
];

export const DEFAULT_VOICE_ID = 'emma';

export function getVoice(id: string | null | undefined): VoiceDef {
	return VOICES.find((v) => v.id === id) ?? VOICES.find((v) => v.id === DEFAULT_VOICE_ID)!;
}

export function clientVoices(): VoiceOption[] {
	return VOICES.map(({ id, label, blurb, engine }) => ({ id, label, blurb, engine }));
}

// Cloud (ElevenLabs) is usable only when a key is present AND not force-local.
// `VOICE_TTS_PROVIDER=local` is a master override that pins everything local
// (Emma then speaks through her local clone) — the operator's one-flip "go fully
// local" switch.
export function cloudAvailable(): boolean {
	const forceLocal = (env.VOICE_TTS_PROVIDER || '').toLowerCase() === 'local';
	return !!env.ELEVENLABS_API_KEY && !forceLocal;
}

// The Chatterbox reference path to use when synthesizing a voice LOCALLY: a
// local voice uses its own ref; a cloud voice uses its local-clone fallback ref.
export function localRefFor(v: VoiceDef): string | undefined {
	return v.voiceRef ?? v.fallbackVoiceRef;
}

// Routing the client uses to reach the right TTS engine for a voice. A cloud
// voice routes to /api/chat/speak (with a local fall-forward); a local voice
// (or a cloud voice when cloud is unavailable) routes straight to speak-local.
export function routingFor(v: VoiceDef): VoiceRouting {
	if (v.engine === 'elevenlabs' && cloudAvailable()) {
		return {
			ttsPath: '/api/chat/speak',
			ttsModel: v.model,
			ttsFallbackPath: v.fallbackVoiceRef ? '/api/chat/speak-local' : undefined
		};
	}
	return { ttsPath: '/api/chat/speak-local', ttsModel: undefined, ttsFallbackPath: undefined };
}
