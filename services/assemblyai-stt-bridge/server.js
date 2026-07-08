// AssemblyAI Universal-Streaming STT bridge for Sully Voice Mode.
//
// Speaks the EXACT /companion-voice WS protocol the iOS client already uses
// (VoiceSTTBridgeClient), so switching Voice Mode from the Jetson STT to
// AssemblyAI is a proxy repoint only — zero app changes, instantly reversible:
//   tailscale serve  /companion-voice -> :18771  (this bridge, AssemblyAI)
//   tailscale serve  /companion-voice -> :18770  (Jetson, the fallback)
//
// iOS → bridge:  {type:config,sampleRate,continuous} | {type:reset} |
//                {type:stop} | <binary Int16 16kHz mono PCM frames>
// bridge → iOS:  {type:ready} | {type:partial,text} | {type:final,text} |
//                {type:error,message}
//
// bridge ↔ AssemblyAI v3 (wss://streaming.assemblyai.com/v3/ws): API key in a
// raw Authorization header (no Bearer); config in query params; PCM16 binary
// frames; Turn messages with immutable finals. Double-final trap handled:
// a turn is FINAL only when end_of_turn && turn_is_formatted.
//
// Protocol facts verified in docs/voice/assemblyai-streaming-and-jetson-techniques.md.

import { WebSocketServer, WebSocket } from 'ws';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.env.ASSEMBLYAI_STT_PORT || 18771);
const API_KEY = process.env.ASSEMBLY_AI_API_KEY;
const MODEL = process.env.ASSEMBLYAI_STT_MODEL || 'u3-rt-pro';
const SPEND_LOG =
	process.env.ASSEMBLYAI_SPEND_LOG ||
	'/home/dreighto/dev/sully-backend/data/assemblyai_stt_sessions.jsonl';

if (!API_KEY) {
	console.error('[aai-stt] ASSEMBLY_AI_API_KEY not set — refusing to start');
	process.exit(1);
}

function aaiUrl() {
	const p = new URLSearchParams({
		sample_rate: '16000',
		encoding: 'pcm_s16le',
		format_turns: 'true',
		speech_model: MODEL,
		// Turn detection tuned for a thoughtful speaker who PAUSES mid-turn (voice
		// turn-taking plan 2026-07-08). Demand strong semantic completeness before
		// ending (0.6), hold ~700ms of silence before firing even when confident,
		// and let a genuine mid-thought pause ride up to ~2.8s before the hard
		// fallback. Env-overridable for field tuning; the end_of_turn &&
		// turn_is_formatted double-final gate below is unchanged.
		end_of_turn_confidence_threshold: process.env.AAI_EOT_CONFIDENCE || '0.6',
		min_end_of_turn_silence_when_confident: process.env.AAI_MIN_EOT_SILENCE_MS || '700',
		max_turn_silence: process.env.AAI_MAX_TURN_SILENCE_MS || '2800'
	});
	return `wss://streaming.assemblyai.com/v3/ws?${p.toString()}`;
}

function logSession(row) {
	try {
		appendFileSync(SPEND_LOG, JSON.stringify(row) + '\n');
	} catch {
		/* non-fatal: telemetry only */
	}
}

// No `path` filter: the tailscale-serve `--set-path /companion-voice` proxy
// strips the matched prefix and forwards `/` to us, so restricting to
// '/companion-voice' would 400 every real connection (verified 2026-07-07).
const wss = new WebSocketServer({ port: PORT });
console.log(`[aai-stt] listening on :${PORT}/companion-voice → ${MODEL}`);

wss.on('connection', (client) => {
	let aai = null;
	let ready = false;
	let audioBytes = 0;
	let lastFinal = '';
	const pendingAudio = []; // frames that arrive before AAI is ready

	const toClient = (obj) => {
		if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj));
	};

	function openAssemblyAI() {
		aai = new WebSocket(aaiUrl(), { headers: { Authorization: API_KEY } });

		aai.on('open', () => {
			// Flush any audio buffered during the handshake.
			for (const frame of pendingAudio) aai.send(frame);
			pendingAudio.length = 0;
		});

		aai.on('message', (raw) => {
			let msg;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			switch (msg.type) {
				case 'Begin':
					ready = true;
					toClient({ type: 'ready' });
					break;
				case 'Turn': {
					const text = (msg.transcript || '').trim();
					if (!text) break;
					// Double-final trap: with format_turns, a turn arrives twice
					// (raw end_of_turn, then formatted). Emit FINAL only when both
					// end_of_turn AND turn_is_formatted; everything else is partial.
					if (msg.end_of_turn && msg.turn_is_formatted) {
						if (text !== lastFinal) {
							lastFinal = text;
							toClient({ type: 'final', text });
						}
					} else {
						toClient({ type: 'partial', text });
					}
					break;
				}
				case 'Termination':
					break;
				default:
					break;
			}
		});

		aai.on('error', (err) => {
			toClient({ type: 'error', message: `stt upstream: ${err?.message || 'error'}` });
		});

		aai.on('close', (code) => {
			if (!ready) toClient({ type: 'error', message: `stt upstream closed (${code})` });
			ready = false;
		});
	}

	client.on('message', (data, isBinary) => {
		if (isBinary) {
			audioBytes += data.length;
			if (aai && aai.readyState === WebSocket.OPEN) aai.send(data);
			else pendingAudio.push(data); // buffer during handshake
			return;
		}
		let obj;
		try {
			obj = JSON.parse(data.toString());
		} catch {
			return;
		}
		switch (obj.type) {
			case 'config':
				if (!aai) openAssemblyAI();
				break;
			case 'reset':
				// Continuous mode: AAI auto-endpoints turns, so a client reset just
				// clears our local final-dedupe guard for the next utterance.
				lastFinal = '';
				break;
			case 'stop':
				if (aai && aai.readyState === WebSocket.OPEN)
					aai.send(JSON.stringify({ type: 'Terminate' }));
				break;
			default:
				break;
		}
	});

	client.on('close', () => {
		if (aai && aai.readyState === WebSocket.OPEN) {
			try {
				aai.send(JSON.stringify({ type: 'Terminate' }));
			} catch {
				/* best effort */
			}
			aai.close();
		} else if (aai) {
			aai.close();
		}
		// ~audio seconds = bytes / (2 bytes/sample * 16000 samples/s). Credits
		// bill on audio duration; log it so spend is auditable.
		const seconds = audioBytes / 32000;
		logSession({ event: 'stt_session', model: MODEL, audio_seconds: Number(seconds.toFixed(1)) });
	});

	client.on('error', () => {
		if (aai) aai.close();
	});
});

process.on('SIGTERM', () => wss.close(() => process.exit(0)));
process.on('SIGINT', () => wss.close(() => process.exit(0)));
