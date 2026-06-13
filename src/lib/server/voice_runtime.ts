// Shared voice-mode runtime tuning. Lives outside the route files so the
// pre-warm endpoint (/api/chat/voice-warm) and the reply stream
// (/api/chat/voice-reply) agree on a single value.

// Holds the voice model resident across conversational pauses — longer than
// Ollama's 5-minute default — without pinning it forever: it still unloads after
// the session so the GPU frees for the operator's other models. Ollama also
// evicts under VRAM pressure, so other models continue to load on demand.
export const VOICE_KEEP_ALIVE = '10m';

// Voice-LLM serving endpoint. Defaults to the JETSON's Ollama (10.10.10.2:11434,
// the direct ROOM↔Jetson link) so the voice reply model NEVER runs on the ROOM
// RTX 5060 Ti. Deliberately distinct from OLLAMA_BASE_URL (which the text path,
// embeddings, working-memory, episode-extractor and Hermes still use). Override
// with COMPANION_VOICE_OLLAMA_URL.
export const VOICE_OLLAMA_URL = (
	process.env.COMPANION_VOICE_OLLAMA_URL || 'http://10.10.10.2:11434'
).replace(/\/+$/, '');

// Hard guard: voice TTS must run on the Jetson bridge, never the local 5060
// Chatterbox. The OLD default was `127.0.0.1:18771` (the 5060 Chatterbox) — that
// silent fallback is removed: an unset COMPANION_TTS_URL now defaults to the
// Jetson bridge, and an explicit `…:18771` is REFUSED (throws). So nothing can
// reach the 5060 — unset → Jetson, misconfig-to-5060 → fail loud. If the Jetson
// TTS is unreachable at request time the caller's fetch errors out; there is
// intentionally no 5060 fallback path.
export function resolveTtsUrl(): string {
	const raw = (process.env.COMPANION_TTS_URL || 'http://10.10.10.2:18780').replace(/\/+$/, '');
	if (/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|::1):18771\b/.test(raw)) {
		throw new Error(
			`COMPANION_TTS_URL points at the local 5060 Chatterbox (${raw}) — refused. Voice TTS must run on the Jetson bridge (e.g. http://10.10.10.2:18780).`
		);
	}
	return raw;
}
