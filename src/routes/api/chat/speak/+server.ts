// Azure Speech text-to-speech proxy.
// POST {text: string, voice?: string, model?: string}
//   → calls Azure Speech SSML endpoint → streams MP3 back
// Voice defaults to Emma (en-US-AriaNeural) when omitted.
// Cap: AZURE_TTS_DAILY_CHAR_CAP env var (falling back to legacy cap env) via
// chat_tts_usage table.

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getTodayTtsUsage, addTtsUsage } from '$lib/server/voice_usage';
import { getVoice, cloudAvailable, localRefFor, DEFAULT_VOICE_ID } from '$lib/server/voices';
import { speakableText } from '$lib/server/tts_normalize';
import { padWavTrailingSilence } from '$lib/server/wav_pad';
import { synthesizeLocalTts } from '$lib/server/voice_tts';
import { synthesizeAzureTts, DEFAULT_AZURE_VOICE } from '$lib/server/azure_tts';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body.text !== 'string' || !body.text.trim()) {
		throw error(400, { message: 'Missing text' });
	}
	const text: string = speakableText(body.text.trim());

	// Force-local master switch (VOICE_TTS_PROVIDER=local): route this "cloud"
	// endpoint to the local Chatterbox service instead of ElevenLabs. Talkback
	// calls this route directly, so this is what makes Talkback honor "go fully
	// local" the same way realtime voice mode does (which routes via voices.ts).
	if (!cloudAvailable()) {
		const v = getVoice(typeof body.voice === 'string' ? body.voice : DEFAULT_VOICE_ID);
		const ttsRes = await synthesizeLocalTts({
			text,
			voice_ref: localRefFor(v),
			cfg_weight: v.cfgWeight,
			exaggeration: v.exaggeration,
			temperature: v.temperature,
			signal: request.signal
		});
		if (!ttsRes.ok) throw error(ttsRes.status, { message: 'local TTS unavailable' });
		// Buffer + pad ~700ms trailing silence so iOS/WebKit's end-of-WAV clip
		// drops silence instead of Sully's last word (talkback only; the client
		// fully buffers this blob anyway, so streaming bought nothing here).
		const raw = Buffer.from(await ttsRes.arrayBuffer());
		const padded = padWavTrailingSilence(raw, 700);
		return new Response(new Uint8Array(padded), {
			status: 200,
			headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' }
		});
	}

	const apiKey = env.AZURE_SPEECH_KEY;
	const region = env.AZURE_SPEECH_REGION;
	if (!apiKey || !region) {
		throw error(503, { message: 'TTS not configured' });
	}

	const dailyCharCap = Number(
		env.AZURE_TTS_DAILY_CHAR_CAP ?? env.ELEVENLABS_DAILY_CHAR_CAP ?? 50_000
	);
	// Resolve the requested voice server-side by opaque id. No `voice` → legacy
	// default (Emma + the body.model override), keeping read-aloud unchanged.
	// Voice mode sends voice:'emma' → Emma + Azure Neural. A non-cloud voice id
	// (e.g. a local-only voice) routes here only as a mistake — fall back to the
	// Emma default rather than 502.
	const reqModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
	let voiceName: string = reqModel ?? DEFAULT_AZURE_VOICE;
	if (typeof body.voice === 'string') {
		const v = getVoice(body.voice);
		if (v.engine === 'azure') {
			voiceName = v.voiceId ?? v.model ?? voiceName;
		}
	}

	// Cap check
	const usedToday = getTodayTtsUsage();
	if (usedToday + text.length > dailyCharCap) {
		return new Response(
			JSON.stringify({ error: 'cap_exhausted', chars_used_today: usedToday, cap: dailyCharCap }),
			{ status: 429, headers: { 'content-type': 'application/json' } }
		);
	}

	let ttsRes: Response;
	try {
		ttsRes = await synthesizeAzureTts({
			text,
			voice: voiceName,
			format: 'mp3',
			signal: request.signal
		});
	} catch (e) {
		console.error('Azure Speech TTS error:', e instanceof Error ? e.message : e);
		throw error(502, { message: 'TTS request failed' });
	}

	// Record usage before streaming so the cap is updated even if client drops
	addTtsUsage(text.length);

	return new Response(ttsRes.body, {
		status: 200,
		headers: {
			'content-type': 'audio/mpeg',
			'cache-control': 'no-store'
		}
	});
};
