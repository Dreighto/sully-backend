// Voice-mode config for the client. Tells the browser where the speech-to-text
// WebSocket lives (the Tailscale Funnel path, resolved relative to the current
// host so no hostname is hardcoded), which voice Sully currently speaks in, the
// switchable voice list, and the default UI flags.
//
// The active voice (persisted in companion_settings) drives the TTS routing:
// a cloud voice → /api/chat/speak (+ local fall-forward); a local voice →
// /api/chat/speak-local. Resolution lives in $lib/server/voices so paths/ids
// never reach the browser.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSetting } from '$lib/server/settings';
import { getVoice, clientVoices, routingFor, DEFAULT_VOICE_ID } from '$lib/server/voices';
import { buildVadConfig } from '$lib/server/voice_vad_config';

export const GET: RequestHandler = () => {
	const activeId = getSetting('active_voice') || DEFAULT_VOICE_ID;
	const voice = getVoice(activeId);
	const routing = routingFor(voice);

	return json({
		voiceEnabled: true,
		// Same-origin path proxied to the STT WS service via Tailscale Funnel.
		// Client builds: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${wsPath}`.
		wsPath: '/companion-voice',
		// Active voice + the switchable list (client-safe: no paths/provider ids).
		voice: voice.id,
		voices: clientVoices(),
		// Per-sentence TTS routing for the active voice.
		ttsPath: routing.ttsPath,
		ttsModel: routing.ttsModel,
		// Same-origin fallback TTS endpoint (cloud voice only): the client tries
		// `ttsPath` first and falls forward here if the primary returns non-OK
		// (cap / quota / 5xx), so a dead cloud voice degrades to the local clone.
		ttsFallbackPath: routing.ttsFallbackPath,
		captionsDefault: true, // show streaming assistant text by default; user can toggle voice-only
		// Hands-free is the operator's primary workflow (wireless headphones + in-app
		// mute). Server-side Silero VAD endpoints the turn; the Mute button gates the
		// mic while listening/thinking. PTT stays available via the in-overlay toggle
		// (better for noisy rooms / no headphones / iOS backgrounding).
		pttDefault: false,
		continuousDefault: true,
		// Rank 1.5 — VAD config exposure. Server-authoritative. Bridge enforces;
		// client renders as a status panel / settings UI bounded by `clamp`. No
		// setter route yet; future Cursor brief picks up the iOS-side UI.
		vad: buildVadConfig()
	});
};
