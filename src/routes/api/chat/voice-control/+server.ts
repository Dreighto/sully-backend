import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getVoiceServiceStatus,
	startVoiceServices,
	stopVoiceServices
} from '$lib/server/voice_services';

export const POST: RequestHandler = async ({ request }) => {
	let action: string;
	try {
		action = (await request.json()).action;
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	if (action === 'status') {
		const status = await getVoiceServiceStatus();
		return json({ ...status, ready: status.bothReady });
	}

	if (action === 'stop') {
		return json(await stopVoiceServices());
	}

	if (action === 'start') {
		const result = await startVoiceServices();
		if (result.ready) return json({ ready: true });
		const error = result.errors[0] || 'failed to start speech services';
		const status = error.startsWith('failed to start speech services') ? 500 : 504;
		return json({ ready: false, error, errors: result.errors }, { status });
	}

	return json({ error: 'unknown action' }, { status: 400 });
};
