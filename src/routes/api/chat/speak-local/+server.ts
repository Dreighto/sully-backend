// Local TTS proxy. Streams Chatterbox-synthesized speech from the companion
// speech service (127.0.0.1:18771) back to the browser. Called per-sentence as
// companion-v1's reply streams. Sits alongside the cloud ElevenLabs /api/chat/speak.
//
// Server-to-server: the TTS service is bound to localhost and is NOT publicly
// exposed; the browser only ever talks to this same-origin route. The incoming
// request's abort signal is propagated to the upstream fetch so a barge-in
// (client aborts) cancels the in-flight synthesis.

import type { RequestHandler } from './$types';
import { getVoice, localRefFor, kokoroVoiceFor } from '$lib/server/voices';
import { speakableText } from '$lib/server/tts_normalize';
import { synthesizeLocalTts } from '$lib/server/voice_tts';

export const POST: RequestHandler = async ({ request }) => {
	let body: { text?: string; voice?: string; voice_ref?: string };
	try {
		body = await request.json();
	} catch {
		return new Response('invalid json', { status: 400 });
	}
	const text = speakableText((body.text || '').trim());
	if (!text) return new Response('empty text', { status: 400 });

	// Resolve the voice's reference clip server-side by opaque id (local voice →
	// its own ref; cloud voice synthesized locally → its clone fallback ref). A
	// legacy explicit `voice_ref` path still works; absent both, the Chatterbox
	// service falls back to its own TTS_VOICE_REF default.
	const voice = body.voice ? getVoice(body.voice) : null;
	const ref = (voice ? localRefFor(voice) : undefined) || body.voice_ref;
	const kokoroVoice = voice ? kokoroVoiceFor(voice) : undefined;

	try {
		const ttsRes = await synthesizeLocalTts({
			text,
			kokoroVoice,
			voice_ref: ref,
			cfg_weight: voice?.cfgWeight,
			exaggeration: voice?.exaggeration,
			temperature: voice?.temperature,
			signal: request.signal
		});
		if (!ttsRes.ok) return new Response('tts unavailable', { status: 502 });

		return new Response(ttsRes.body, {
			headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }
		});
	} catch (e) {
		if (e instanceof Error && e.name === 'AbortError') {
			return new Response(null, { status: 499 });
		}
		return new Response('tts service unreachable', { status: 502 });
	}
};
