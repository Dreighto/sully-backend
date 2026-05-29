// GET /api/chat/usage — today's token usage per provider with cap %

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getTodayTokenUsage } from '$lib/server/thread_state';
import { serverConfig } from '$lib/server/config';

export const GET: RequestHandler = async () => {
	try {
		const usage = getTodayTokenUsage();
		const caps = {
			anthropic: serverConfig.anthropicDailyTokenCap,
			openai: serverConfig.openaiDailyTokenCap,
			gemini: serverConfig.geminiDailyTokenCap
		};

		const providers = Object.entries(caps).map(([name, cap]) => ({
			provider: name,
			tokens_used: usage[name] ?? 0,
			cap,
			pct: cap > 0 ? Math.min(100, Math.round(((usage[name] ?? 0) / cap) * 100)) : 0
		}));

		return json({ providers });
	} catch (e) {
		console.error('GET /api/chat/usage error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
