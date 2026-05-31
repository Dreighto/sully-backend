// ElevenLabs text-to-speech proxy.
// POST {text: string, voice_id?: string}
//   → calls ElevenLabs /v1/text-to-speech/<voice_id> → streams MP3 back
// Voice locked to Emma (56bWURjYFHyYyVf490Dp) when voice_id omitted.
// Cap: ELEVENLABS_DAILY_CHAR_CAP env var (default 50000) via chat_tts_usage table.

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getTodayTtsUsage, addTtsUsage } from '$lib/server/voice_usage';
import { getVoice, cloudAvailable, localRefFor, DEFAULT_VOICE_ID } from '$lib/server/voices';
import { startVoiceServices } from '$lib/server/voice_services';

const EMMA_VOICE_ID = '56bWURjYFHyYyVf490Dp';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const TTS_URL = (process.env.COMPANION_TTS_URL || 'http://127.0.0.1:18771').replace(/\/+$/, '');

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body.text !== 'string' || !body.text.trim()) {
		throw error(400, { message: 'Missing text' });
	}
	const text: string = body.text.trim();

	// Force-local master switch (VOICE_TTS_PROVIDER=local): route this "cloud"
	// endpoint to the local Chatterbox service instead of ElevenLabs. Talkback
	// calls this route directly, so this is what makes Talkback honor "go fully
	// local" the same way realtime voice mode does (which routes via voices.ts).
	if (!cloudAvailable()) {
		const v = getVoice(typeof body.voice === 'string' ? body.voice : DEFAULT_VOICE_ID);
		const ref = localRefFor(v);
		const synth = () =>
			fetch(`${TTS_URL}/tts`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					text,
					voice_ref: ref,
					cfg_weight: v.cfgWeight,
					exaggeration: v.exaggeration,
					temperature: v.temperature
				}),
				signal: request.signal
			}).catch(() => null);
		let upstream = await synth();
		if (!upstream || !upstream.ok || !upstream.body) {
			// TTS is on-demand (stopped when voice mode exits). Wake it + retry once
			// so read-aloud / Talkback work even from a cold GPU.
			await startVoiceServices().catch(() => null);
			upstream = await synth();
		}
		if (!upstream || !upstream.ok || !upstream.body) {
			throw error(502, { message: 'local TTS unavailable' });
		}
		return new Response(upstream.body, {
			status: 200,
			headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' }
		});
	}

	const apiKey = env.ELEVENLABS_API_KEY;
	if (!apiKey) {
		throw error(503, { message: 'TTS not configured' });
	}

	const dailyCharCap = Number(env.ELEVENLABS_DAILY_CHAR_CAP ?? 50_000);
	// Resolve the requested voice server-side by opaque id. No `voice` → legacy
	// default (Emma + the body.model override or turbo), keeping read-aloud
	// unchanged. Voice mode sends voice:'emma' → Emma + flash. A non-ElevenLabs
	// voice id (e.g. a local-only voice) routes here only as a mistake — fall back
	// to the Emma default rather than 502.
	const reqModel =
		typeof body.model === 'string' && body.model.startsWith('eleven_') ? body.model : null;
	let voiceId: string = EMMA_VOICE_ID; // locked default per design §2D.2
	let modelId: string = reqModel ?? 'eleven_turbo_v2_5';
	if (typeof body.voice === 'string') {
		const v = getVoice(body.voice);
		if (v.engine === 'elevenlabs') {
			voiceId = v.voiceId ?? EMMA_VOICE_ID;
			modelId = v.model ?? modelId;
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

	const ttsRes = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
		method: 'POST',
		headers: {
			'xi-api-key': apiKey,
			'content-type': 'application/json',
			accept: 'audio/mpeg'
		},
		body: JSON.stringify({
			text,
			model_id: modelId,
			voice_settings: { stability: 0.5, similarity_boost: 0.75 }
		})
	});

	if (!ttsRes.ok) {
		const errBody = await ttsRes.text();
		console.error('ElevenLabs TTS error:', ttsRes.status, errBody);
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
