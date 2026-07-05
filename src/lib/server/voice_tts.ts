// Shared local TTS synthesis — wraps the Jetson bridge /tts endpoint with
// cold-start restart + one retry. The speak/+server.ts and speak-local/+server.ts
// routes both duplicated this pattern; the voice-stream path (voice_stream.ts)
// uses a simpler inline fetch without restart retry.
//
// Exports a single helper so all three agree on restart behaviour and the
// local-vs-cloud dispatch stays in the route layer.

import { speakableText } from '$lib/server/tts_normalize';
import { resolveTtsUrl } from '$lib/server/voice_runtime';
import { restartTtsService } from '$lib/server/voice_services';

const TTS_URL = resolveTtsUrl();

export interface SynthesizeOptions {
	text: string;
	voice_ref?: string;
	cfg_weight?: number;
	exaggeration?: number;
	temperature?: number;
	signal?: AbortSignal;
	kokoroVoice?: string;
}

export async function synthesizeLocalTts(opts: SynthesizeOptions): Promise<Response> {
	const text = speakableText(opts.text.trim());
	if (!text) return new Response('empty text', { status: 400 });

	const body = JSON.stringify({
		text,
		voice: opts.kokoroVoice,
		voice_ref: opts.voice_ref,
		cfg_weight: opts.cfg_weight,
		exaggeration: opts.exaggeration,
		temperature: opts.temperature
	});

	const synth = () =>
		fetch(`${TTS_URL}/tts`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
			signal: opts.signal
		}).catch((e: unknown) => {
			if (e instanceof Error && e.name === 'AbortError') throw e;
			return null;
		});

	let upstream = await synth();
	if (!upstream || !upstream.ok) {
		await restartTtsService().catch(() => null);
		upstream = await synth();
	}
	if (!upstream || !upstream.ok || !upstream.body) {
		return new Response('local TTS unavailable', {
			status: upstream?.status ?? 502
		});
	}
	return upstream;
}
