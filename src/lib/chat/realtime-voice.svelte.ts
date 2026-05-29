// Realtime Voice Mode controller — the immersive, low-latency voice pipeline
// the operator asked for: see your own speech transcribed live (like Claude
// Code), watch the companion's reply stream as text (toggleable off for a
// voice-only experience), hear it spoken in the natural local Chatterbox voice,
// and barge in at any time.
//
// This is DISTINCT from the legacy in-composer Talkback loop
// ($lib/chat/voice.svelte.ts): that uses the browser Web Speech API + cloud
// STT/TTS + reply polling. This controller is the local-GPU realtime stack:
//
//   mic ──AudioWorklet(Int16)──▶ WS /companion-voice (faster-whisper)
//        live partials ──▶ `partial`   final ──▶ /api/chat/voice-reply
//        reply tokens ──▶ `replyText` (+ sentence segmenter)
//        per sentence ──▶ /api/chat/speak-local (Chatterbox) ──▶ gapless Web Audio
//
// Barge-in: pressing the mic again while the companion is thinking/speaking
// aborts the reply fetch + the in-flight TTS fetch, stops every scheduled audio
// node, and starts listening fresh.
//
// REACTIVE OWNERSHIP (Svelte 5 runes discipline). Legal `$state` here because
// the file is `.svelte.ts`. The reactive surface the overlay renders is exposed
// ONLY through getters (each call samples the live `$state`). The device-level
// resources (WebSocket, AudioContext × 2, AudioWorkletNode, MediaStream,
// AbortControllers, WakeLock) are plain `let`s — imperative resources, not
// render state — and every one is released on `exit()`/`destroy()`.
//
// On-demand GPU: `enter()` starts the STT+TTS systemd services (so they don't
// hold ~14 GB of VRAM when voice is idle and other models need the GPU), and
// `exit()` stops them again. The window stays free for the other models the
// operator runs whenever voice mode is closed.

import { base } from '$app/paths';
import { resolve } from '$app/paths';
import type { VoicePhase } from '$lib/types/chat-ui';

// The page-owned bits the voice controller needs. Reads are getters; the one
// write-ish action reconciles the chat feed against the DB after a turn (the
// voice-reply route persists both the operator's utterance and the reply
// server-side, so a single poll picks up the whole turn).
export interface RealtimeVoiceDeps {
	getActiveThread: () => string;
	/** Reconcile the rendered feed against the DB after a voice turn persists. */
	pollMessages: () => Promise<void>;
}

export interface RealtimeVoiceController {
	/** Voice Mode overlay is open. */
	readonly open: boolean;
	/** Current pipeline phase (drives the overlay's visual state). */
	readonly phase: VoicePhase;
	/** Live partial transcript of the operator's in-progress utterance. */
	readonly partial: string;
	/** The finalized operator utterance for the current turn. */
	readonly userText: string;
	/** The companion's reply text, streaming in (rendered when captions on). */
	readonly replyText: string;
	/** Whether the streaming reply text is shown (false = voice-only). */
	readonly captions: boolean;
	/** Push-to-talk is currently held. */
	readonly holding: boolean;
	/** Both speech services are up and the WS is ready. */
	readonly servicesReady: boolean;
	/** Set when the session hit an unrecoverable error (phase === 'error'). */
	readonly errorMsg: string | null;
	/** Open Voice Mode: start speech services, mic, playback, WS. Call from a user gesture. */
	enter: () => Promise<void>;
	/** Close Voice Mode: tear down everything + stop the speech services. */
	exit: () => Promise<void>;
	/** Push-to-talk down (also barges in if the companion is thinking/speaking). */
	pressStart: () => Promise<void>;
	/** Push-to-talk up: finalize the utterance and wait for the reply. */
	pressEnd: () => void;
	/** Toggle the streaming reply captions (voice-only when off). */
	toggleCaptions: () => void;
	/** Re-resume the audio contexts (call on visibilitychange — iOS suspends them). */
	resumeAudio: () => void;
	/** onDestroy hook — release everything. */
	destroy: () => Promise<void>;
}

interface VoiceConfig {
	voiceEnabled: boolean;
	wsPath: string;
	ttsPath: string;
	captionsDefault: boolean;
	pttDefault: boolean;
	voiceRef?: string;
}

export function createRealtimeVoiceController(
	deps: RealtimeVoiceDeps
): RealtimeVoiceController {
	// ── Reactive UI state ────────────────────────────────────────────────
	let open = $state(false);
	let phase = $state<VoicePhase>('idle');
	let partial = $state('');
	let userText = $state('');
	let replyText = $state('');
	let captions = $state(true);
	let holding = $state(false);
	let servicesReady = $state(false);
	let errorMsg = $state<string | null>(null);

	// ── Config (fetched on first enter) ──────────────────────────────────
	let wsPath = '/companion-voice';
	let ttsPath = '/api/chat/speak-local';
	let voiceRef: string | undefined;

	// ── STT transport / mic capture (imperative) ─────────────────────────
	let ws: WebSocket | null = null;
	let micStream: MediaStream | null = null;
	let micCtx: AudioContext | null = null;
	let workletNode: AudioWorkletNode | null = null;
	let micSource: MediaStreamAudioSourceNode | null = null;

	// ── Reply stream (imperative) ────────────────────────────────────────
	let replyAbort: AbortController | null = null;
	let replyDone = true;

	// ── TTS playback (imperative, gapless Web Audio) ─────────────────────
	let playCtx: AudioContext | null = null;
	let ttsQueue: string[] = [];
	let ttsBuffer = ''; // reply text not yet segmented into a sentence
	let pumping = false;
	let ttsAbort: AbortController | null = null;
	let nextStart = 0; // playback cursor for gapless scheduling
	let activeSources: AudioBufferSourceNode[] = [];

	// ── Screen wake lock (imperative) ────────────────────────────────────
	let wakeLock: WakeLockSentinel | null = null;

	// ──────────────────────────────────────────────────────────────────────
	// TTS playback
	// ──────────────────────────────────────────────────────────────────────

	// Flush every complete sentence out of `ttsBuffer` and enqueue it for
	// synthesis. "Complete" = a terminator (.?!) followed by whitespace, so we
	// speak sentence-by-sentence as the reply streams instead of waiting for the
	// whole thing. The trailing (in-progress) fragment stays buffered.
	function segmentReply(chunk: string) {
		replyText += chunk;
		ttsBuffer += chunk;
		const re = /(.*?[.!?]+)(\s+)/s;
		let m: RegExpMatchArray | null;
		while ((m = ttsBuffer.match(re)) !== null) {
			const sentence = m[1].trim();
			ttsBuffer = ttsBuffer.slice(m[0].length);
			if (sentence) enqueueTts(sentence);
		}
	}

	// End of the reply stream: speak whatever fragment is left over.
	function flushReply() {
		const tail = ttsBuffer.trim();
		ttsBuffer = '';
		if (tail) enqueueTts(tail);
	}

	function enqueueTts(sentence: string) {
		ttsQueue.push(sentence);
		if (!pumping) void pumpTts();
	}

	async function fetchTtsBuffer(text: string): Promise<AudioBuffer | null> {
		if (!playCtx) return null;
		ttsAbort = new AbortController();
		try {
			// ttsPath comes from server config (a runtime string), so it can't go
			// through the typed route `resolve()`; prepend the app base directly.
			const r = await fetch(`${base}${ttsPath}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text, voice_ref: voiceRef }),
				signal: ttsAbort.signal
			});
			if (!r.ok) return null;
			const ab = await r.arrayBuffer();
			return await playCtx.decodeAudioData(ab);
		} catch {
			// AbortError (barge-in) or decode failure → drop this sentence
			return null;
		} finally {
			ttsAbort = null;
		}
	}

	function scheduleBuffer(buf: AudioBuffer) {
		if (!playCtx || !open) return;
		if (phase !== 'speaking') phase = 'speaking';
		const src = playCtx.createBufferSource();
		src.buffer = buf;
		src.connect(playCtx.destination);
		const start = Math.max(playCtx.currentTime, nextStart);
		src.start(start);
		nextStart = start + buf.duration;
		activeSources.push(src);
		src.onended = () => {
			activeSources = activeSources.filter((s) => s !== src);
			maybeFinishTurn();
		};
	}

	async function pumpTts() {
		pumping = true;
		try {
			while (ttsQueue.length > 0 && open) {
				const sentence = ttsQueue.shift()!;
				const buf = await fetchTtsBuffer(sentence);
				if (buf && open) scheduleBuffer(buf);
			}
		} finally {
			pumping = false;
		}
		maybeFinishTurn();
	}

	// A turn is finished once the reply stream has ended, nothing is queued or
	// being synthesized, and every scheduled audio node has played out. Then we
	// drop back to 'idle' (ready for the next push-to-talk) and sync the feed.
	function maybeFinishTurn() {
		if (!open) return;
		if (replyDone && !pumping && ttsQueue.length === 0 && activeSources.length === 0) {
			if (phase === 'speaking' || phase === 'thinking') phase = 'idle';
		}
	}

	function stopPlayback() {
		ttsAbort?.abort();
		ttsAbort = null;
		ttsQueue = [];
		ttsBuffer = '';
		for (const s of activeSources) {
			try {
				s.stop();
			} catch {
				/* already stopped */
			}
		}
		activeSources = [];
		nextStart = playCtx ? playCtx.currentTime : 0;
	}

	// ──────────────────────────────────────────────────────────────────────
	// Reply stream (companion-v1-voice via /api/chat/voice-reply)
	// ──────────────────────────────────────────────────────────────────────

	async function startReply(text: string) {
		phase = 'thinking';
		replyDone = false;
		replyAbort = new AbortController();
		nextStart = playCtx ? playCtx.currentTime : 0;
		try {
			const r = await fetch(resolve('/api/chat/voice-reply'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text, thread: deps.getActiveThread() }),
				signal: replyAbort.signal
			});
			if (!r.ok || !r.body) {
				errorMsg = 'The companion could not reply.';
				phase = 'idle';
				return;
			}
			const reader = r.body.getReader();
			const dec = new TextDecoder();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				const chunk = dec.decode(value, { stream: true });
				if (chunk) segmentReply(chunk);
			}
		} catch {
			// AbortError = barge-in (expected); other errors just end the turn.
		} finally {
			replyAbort = null;
			replyDone = true;
			flushReply();
			// The reply was persisted server-side; reconcile the feed so the
			// transcript is there when the operator closes Voice Mode.
			void deps.pollMessages();
			maybeFinishTurn();
		}
	}

	function abortReply() {
		replyAbort?.abort();
		replyAbort = null;
		replyDone = true;
	}

	// ──────────────────────────────────────────────────────────────────────
	// STT WebSocket + mic
	// ──────────────────────────────────────────────────────────────────────

	function onWsMessage(ev: MessageEvent) {
		if (typeof ev.data !== 'string') return;
		let m: { type?: string; text?: string; error?: string };
		try {
			m = JSON.parse(ev.data);
		} catch {
			return;
		}
		switch (m.type) {
			case 'partial':
				if (holding) partial = m.text ?? '';
				break;
			case 'final':
				handleFinal(m.text ?? '');
				break;
			case 'error':
				errorMsg = m.error ?? 'Speech recognition error.';
				break;
			// 'ready' is consumed by connectWs()'s open handshake.
		}
	}

	function handleFinal(text: string) {
		partial = '';
		const t = text.trim();
		userText = t;
		if (!t) {
			// Nothing intelligible heard — drop back to idle, no reply.
			if (phase === 'thinking') phase = 'idle';
			return;
		}
		void startReply(t);
	}

	function connectWs(): Promise<void> {
		return new Promise((res, rej) => {
			const proto = location.protocol === 'https:' ? 'wss' : 'ws';
			// wsPath is a ROOT Funnel path (sibling of the app's base), so it is NOT
			// run through resolve() — that would wrongly prepend the app base.
			const socket = new WebSocket(`${proto}://${location.host}${wsPath}`);
			socket.binaryType = 'arraybuffer';
			ws = socket;
			let settled = false;
			const openTimer = setTimeout(() => {
				if (!settled) {
					settled = true;
					rej(new Error('Speech socket timed out.'));
				}
			}, 20_000);
			socket.onmessage = (ev) => {
				// First message is the server's {type:'ready'} handshake.
				if (!settled && typeof ev.data === 'string' && ev.data.includes('"ready"')) {
					settled = true;
					clearTimeout(openTimer);
					try {
						socket.send(
							JSON.stringify({ type: 'config', sampleRate: micCtx?.sampleRate ?? 48000 })
						);
					} catch {
						/* will surface on first send */
					}
					socket.onmessage = onWsMessage;
					res();
					return;
				}
				onWsMessage(ev);
			};
			socket.onerror = () => {
				if (!settled) {
					settled = true;
					clearTimeout(openTimer);
					rej(new Error('Could not reach the speech service.'));
				}
			};
			socket.onclose = () => {
				if (open && phase !== 'error') {
					errorMsg = 'Speech connection dropped.';
					phase = 'error';
				}
			};
		});
	}

	function closeWs() {
		if (ws) {
			ws.onmessage = null;
			ws.onerror = null;
			ws.onclose = null;
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			ws = null;
		}
	}

	async function startMic() {
		micStream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
		});
		if (!micCtx) micCtx = new AudioContext();
		await micCtx.audioWorklet.addModule(`${base}/pcm-capture-worklet.js`);
		micSource = micCtx.createMediaStreamSource(micStream);
		workletNode = new AudioWorkletNode(micCtx, 'pcm-capture');
		workletNode.port.onmessage = (e: MessageEvent) => {
			// Only ship audio while PTT is held; the worklet runs continuously.
			if (holding && ws && ws.readyState === WebSocket.OPEN) {
				ws.send(e.data as ArrayBuffer);
			}
		};
		micSource.connect(workletNode);
		// The worklet writes no output, so this is silent — it only keeps the
		// audio graph pulling so process() runs on every browser.
		workletNode.connect(micCtx.destination);
		// A track ending (mic unplugged / revoked) is fatal to the session.
		micStream.getTracks().forEach((track) => {
			track.onended = () => {
				if (open) {
					errorMsg = 'Microphone disconnected.';
					phase = 'error';
				}
			};
		});
	}

	function teardownMic() {
		if (workletNode) {
			workletNode.port.onmessage = null;
			try {
				workletNode.disconnect();
			} catch {
				/* ignore */
			}
			workletNode = null;
		}
		if (micSource) {
			try {
				micSource.disconnect();
			} catch {
				/* ignore */
			}
			micSource = null;
		}
		micStream?.getTracks().forEach((t) => t.stop());
		micStream = null;
	}

	// ──────────────────────────────────────────────────────────────────────
	// Lifecycle
	// ──────────────────────────────────────────────────────────────────────

	function resumeAudio() {
		if (micCtx && micCtx.state === 'suspended') void micCtx.resume();
		if (playCtx && playCtx.state === 'suspended') void playCtx.resume();
	}

	async function enter() {
		if (open) return;
		open = true;
		phase = 'connecting';
		errorMsg = null;
		partial = '';
		userText = '';
		replyText = '';
		replyDone = true;

		// In-gesture, SYNCHRONOUS: create + resume the audio contexts NOW so iOS
		// unlocks them. Any later (post-await) creation loses the user-gesture
		// context and iOS refuses to start audio.
		try {
			playCtx = playCtx ?? new AudioContext();
			micCtx = micCtx ?? new AudioContext();
			void playCtx.resume();
			void micCtx.resume();
		} catch {
			/* will surface below */
		}

		try {
			// 1. config
			const cfgResp = await fetch(resolve('/api/chat/voice-config'));
			if (cfgResp.ok) {
				const cfg = (await cfgResp.json()) as VoiceConfig;
				if (cfg.voiceEnabled === false) throw new Error('Voice mode is disabled.');
				wsPath = cfg.wsPath || wsPath;
				ttsPath = cfg.ttsPath || ttsPath;
				captions = cfg.captionsDefault ?? true;
				voiceRef = cfg.voiceRef;
			}

			// 2. start the on-demand speech services (may take a while cold).
			const ctl = await fetch(resolve('/api/chat/voice-control'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'start' })
			});
			const ctlBody = (await ctl.json().catch(() => ({}))) as { ready?: boolean };
			if (!ctl.ok || !ctlBody.ready) throw new Error('The voice services did not start.');
			servicesReady = true;

			// 3. mic capture + 4. STT socket
			await startMic();
			await connectWs();

			// 5. keep the screen awake during a voice conversation (best effort).
			try {
				if ('wakeLock' in navigator) {
					wakeLock = await (
						navigator as Navigator & {
							wakeLock: { request(type: string): Promise<WakeLockSentinel> };
						}
					).wakeLock.request('screen');
				}
			} catch {
				/* no wake lock — fine */
			}

			phase = 'idle';
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : 'Voice mode failed to start.';
			phase = 'error';
		}
	}

	async function exit() {
		if (!open) return;
		open = false;
		holding = false;
		partial = '';

		abortReply();
		stopPlayback();
		teardownMic();
		closeWs();

		if (wakeLock) {
			await wakeLock.release().catch(() => {});
			wakeLock = null;
		}
		if (playCtx) {
			await playCtx.close().catch(() => {});
			playCtx = null;
		}
		if (micCtx) {
			await micCtx.close().catch(() => {});
			micCtx = null;
		}
		phase = 'idle';

		// Free the GPU: stop the on-demand speech services.
		if (servicesReady) {
			try {
				await fetch(resolve('/api/chat/voice-control'), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ action: 'stop' })
				});
			} catch {
				/* best effort */
			}
			servicesReady = false;
		}
		// Final reconcile so the spoken turns land in the rendered feed.
		void deps.pollMessages();
	}

	async function pressStart() {
		if (!open || phase === 'connecting' || phase === 'error') return;
		resumeAudio();
		// Barge-in: cut off the companion mid-thought / mid-sentence.
		if (phase === 'thinking' || phase === 'speaking') {
			abortReply();
			stopPlayback();
		}
		replyText = '';
		userText = '';
		partial = '';
		replyDone = true;
		// Tell the STT server to start a clean utterance buffer.
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ type: 'reset' }));
			} catch {
				/* ignore */
			}
		}
		holding = true;
		phase = 'listening';
	}

	function pressEnd() {
		if (!holding) return;
		holding = false;
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ type: 'stop' }));
			} catch {
				/* ignore */
			}
		}
		// Wait for the server's final → handleFinal kicks off the reply.
		phase = 'thinking';
	}

	function toggleCaptions() {
		captions = !captions;
	}

	return {
		get open() {
			return open;
		},
		get phase() {
			return phase;
		},
		get partial() {
			return partial;
		},
		get userText() {
			return userText;
		},
		get replyText() {
			return replyText;
		},
		get captions() {
			return captions;
		},
		get holding() {
			return holding;
		},
		get servicesReady() {
			return servicesReady;
		},
		get errorMsg() {
			return errorMsg;
		},
		enter,
		exit,
		pressStart,
		pressEnd,
		toggleCaptions,
		resumeAudio,
		destroy: () => exit()
	};
}
