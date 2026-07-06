import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getVoiceServiceStatus,
	startVoiceServices,
	stopVoiceServices
} from '$lib/server/voice_services';
import { cloudAvailable } from '$lib/server/voices';

export const POST: RequestHandler = async ({ request }) => {
	let action: string;
	try {
		action = (await request.json()).action;
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	if (action === 'status') {
		const status = await getVoiceServiceStatus();
		// When cloud TTS is primary, Chatterbox was intentionally skipped on start —
		// gate readiness on STT only so the voice session isn't blocked on a service
		// that was never launched.
		const ready = cloudAvailable() ? status.stt === 'active' : status.bothReady;
		return json({ ...status, ready });
	}

	if (action === 'stop') {
		return json(await stopVoiceServices());
	}

	if (action === 'start') {
		// Skip Chatterbox startup when cloud TTS is the active provider — it
		// saves 3.2 GB of VRAM and the 21-second GPU cold-start. If cloud TTS caps
		// out mid-session, speak-local cold-starts Chatterbox on demand.
		const result = await startVoiceServices(undefined, { skipTts: cloudAvailable() });
		if (result.ready) return json({ ready: true });
		const error = result.errors[0] || 'failed to start speech services';
		// A `failed` unit (crash loop / dead service) is service-unavailable, not a
		// gateway timeout — surface it as 503 so the fast-fail reads distinctly from
		// the genuine cold-start timeout (504). `reason` is forwarded for the client
		// + logs; the client shows the offline toast either way.
		const status =
			result.reason === 'unit_failed'
				? 503
				: error.startsWith('failed to start speech services')
					? 500
					: 504;
		return json({ ready: false, error, errors: result.errors, reason: result.reason }, { status });
	}

	return json({ error: 'unknown action' }, { status: 400 });
};
