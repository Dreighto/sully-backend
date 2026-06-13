// Pre-warm the voice model. Voice Mode's first reply is otherwise a COLD load
// (~14 GB into VRAM) that the operator feels as a long pause before Sully ever
// speaks. The overlay fires this fire-and-forget the moment Voice Mode opens, so
// the model loads in parallel with mic + STT-socket setup and is resident by the
// time the operator finishes their first sentence.
//
// keep_alive holds it warm through conversational pauses (longer than Ollama's
// 5-min default) without pinning it forever — it still unloads after the session
// so the GPU is free for the operator's other models.

import type { RequestHandler } from './$types';
import { resolveVoiceModel } from '$lib/server/model_catalog';
import { VOICE_KEEP_ALIVE, VOICE_OLLAMA_URL } from '$lib/server/voice_runtime';

// Voice model is warmed on the Jetson Ollama, never the ROOM 5060.
const OLLAMA = VOICE_OLLAMA_URL;
const VOICE_MODEL = resolveVoiceModel();

export const POST: RequestHandler = async ({ request }) => {
	try {
		const upstream = await fetch(`${OLLAMA}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: VOICE_MODEL,
				// Minimal request whose only job is to fault the weights into VRAM.
				messages: [{ role: 'user', content: 'hi' }],
				stream: false,
				keep_alive: VOICE_KEEP_ALIVE,
				options: { num_ctx: 4096, num_predict: 1 }
			}),
			signal: request.signal
		});
		// We don't care about the content — only that the load happened.
		return new Response(JSON.stringify({ warmed: upstream.ok }), {
			status: upstream.ok ? 200 : 502,
			headers: { 'Content-Type': 'application/json' }
		});
	} catch {
		// Aborted (overlay closed) or model unreachable — warming is best-effort.
		return new Response(JSON.stringify({ warmed: false }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	}
};
