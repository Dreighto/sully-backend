// Voice usage status endpoint.
// GET → {chars_used, char_cap, minutes_used, minute_cap}

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getTodaySttUsage, getTodayTtsUsage } from '$lib/server/voice_usage';

export const GET: RequestHandler = async () => {
	const charCap = Number(env.AZURE_TTS_DAILY_CHAR_CAP ?? env.ELEVENLABS_DAILY_CHAR_CAP ?? 50_000);
	const minuteCap = Number(env.ASSEMBLYAI_DAILY_MINUTE_CAP ?? 30);

	return json({
		chars_used: getTodayTtsUsage(),
		char_cap: charCap,
		minutes_used: getTodaySttUsage(),
		minute_cap: minuteCap
	});
};
