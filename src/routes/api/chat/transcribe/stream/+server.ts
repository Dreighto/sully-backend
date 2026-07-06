// AssemblyAI realtime-streaming token endpoint (PR 5 — Talkback Mode).
//
// GET → {token, ws_url}
//
// The client uses this token to open a WebSocket directly to AssemblyAI's
// realtime endpoint. The API key never leaves the server (token pattern).
// Token expires in 480 s — enough for one talkback session.
//
// Guard: returns 503 if ASSEMBLY_AI_API_KEY is not configured,
//        429 if the daily STT minute cap is already exhausted,
//        503 if ENABLE_TALKBACK env var is explicitly "false".

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getTodaySttUsage } from '$lib/server/voice_usage';

const ASSEMBLYAI_TOKEN_URL = 'https://api.assemblyai.com/v2/realtime/token';
const TOKEN_TTL_SECONDS = 480;

export const GET: RequestHandler = async () => {
	if (env.ENABLE_TALKBACK === 'false') {
		throw error(503, { message: 'Talkback not enabled on this server' });
	}

	const apiKey = env.ASSEMBLY_AI_API_KEY;
	if (!apiKey) {
		throw error(503, { message: 'STT not configured' });
	}

	const dailyCapMinutes = Number(env.ASSEMBLYAI_DAILY_MINUTE_CAP ?? 30);
	const usedToday = getTodaySttUsage();
	if (usedToday >= dailyCapMinutes) {
		return json({ error: 'cap_exhausted', usage_today_minutes: usedToday }, { status: 429 });
	}

	const tokenRes = await fetch(ASSEMBLYAI_TOKEN_URL, {
		method: 'POST',
		headers: {
			authorization: apiKey,
			'content-type': 'application/json'
		},
		body: JSON.stringify({ expires_in: TOKEN_TTL_SECONDS })
	});

	if (!tokenRes.ok) {
		const body = await tokenRes.text();
		console.error('AssemblyAI token error:', tokenRes.status, body);
		throw error(502, { message: 'Failed to get realtime token' });
	}

	const { token } = (await tokenRes.json()) as { token: string };

	return json({
		token,
		ws_url: `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&token=${token}`
	});
};
