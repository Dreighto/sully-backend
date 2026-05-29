// GET  /api/chat/tier?thread_id=<id>  — return current tier + override
// PUT  /api/chat/tier                 — set operator overrides for a thread.
//                                       Body may include { tier } and/or
//                                       { provider } — only the fields
//                                       present are updated.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getThreadState,
	setOperatorOverride,
	setProviderOverride,
	type ProviderPreference
} from '$lib/server/thread_state';
import type { Tier } from '$lib/server/phase_classifier';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const threadId = (url.searchParams.get('thread_id') || 'default').trim() || 'default';
		const state = getThreadState(threadId);
		return json({
			thread_id: threadId,
			current_tier: state.current_tier,
			operator_override: state.operator_override,
			provider_override: state.provider_override,
			last_model_used: state.last_model_used
		});
	} catch (e) {
		console.error('GET /api/chat/tier error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};

const VALID_TIERS: Tier[] = ['chat', 'planning', 'deep', 'local'];
const VALID_PROVIDERS: ProviderPreference[] = ['anthropic', 'gemini', 'local'];

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const threadId = (typeof body.thread_id === 'string' ? body.thread_id.trim() : '') || 'default';

		if ('tier' in body) {
			const override: Tier | null = VALID_TIERS.includes(body.tier as Tier)
				? (body.tier as Tier)
				: null;
			setOperatorOverride(threadId, override);
		}
		if ('provider' in body) {
			const provider: ProviderPreference = VALID_PROVIDERS.includes(
				body.provider as ProviderPreference
			)
				? (body.provider as ProviderPreference)
				: null;
			setProviderOverride(threadId, provider);
		}

		const state = getThreadState(threadId);
		return json({
			thread_id: threadId,
			current_tier: state.current_tier,
			operator_override: state.operator_override,
			provider_override: state.provider_override
		});
	} catch (e) {
		console.error('PUT /api/chat/tier error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
