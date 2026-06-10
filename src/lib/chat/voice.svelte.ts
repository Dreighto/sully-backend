// Voice / talkback state machine — extracted from chat/+page.svelte (cleanup ③
// slice 3c). Owns two cohesive concerns:
//   1. iOS audio-unlock workaround (a muted blip on first user gesture so the
//      persistent <audio> element is allowed to play TTS later).
//   2. The hands-free continuous "Talkback" loop: capture → dispatch → wait for
//      reply → speak (TTS) → chime → loop.
//
// CAPTURE TRANSPORT (LOS-174 / T1a). Talkback STT routes through the local
// Jetson STT WebSocket bridge (`/companion-voice` → `logueos-companion-stt`
// :18770 → Jetson unified voice service http://10.10.10.2:18780), gated by
// `TALKBACK_STT_VIA_BRIDGE`. When the bridge is unreachable (Jetson offline /
// mic denied / WS down) talkback surfaces an EXPLICIT error and the composer
// stays usable — there is NO silent browser/cloud (AssemblyAI) fallback. The
// legacy browser Web Speech API + AssemblyAI capture path is kept INTACT behind
// the disabled flag as rollback safety until the on-device cutover is verified
// (do not delete `acquireTranscriptViaLegacy` / `beginTalkbackCaptureViaMediaRecorder`).
//
// REACTIVE OWNERSHIP. This module owns exactly two reactive values — `active`
// and `phase` — via `$state` (legal because the file is `.svelte.ts`). Only
// `phase` is read by the template (Composer's talkback status strip);
// `active` is internal loop-control state. Everything the page owns
// (`composerMode`, `textDraft`, `messages`, `currentTier`, `userAtBottom`,
// `audioEl`, `activeThread`, `selectedRepo`, `pollMessages`) is reached ONLY
// through the explicit `VoiceDeps` port — getters for reads, setters/actions
// for writes — so reactive ownership stays where the template binds it and we
// never reach across the module boundary with a raw reference. The device-
// level refs (MediaStream, AudioContext, ScriptProcessor, WakeLock,
// MediaRecorder, SpeechRecognition) are plain `let`s — they are imperative
// resources, not render state.
//
// `SpeechRecognition` comes from the ambient `$lib/types/web-speech.d.ts`
// (absent from the TS DOM lib).

import { base, resolve } from '$app/paths';
import { toasts } from '$lib/utils/toasts';
import { parseSttMessage, isTalkbackStopWord, buildVoiceWsUrl } from '$lib/chat/stt-bridge';
import type { Tier, ComposerMode, TalkbackPhase, ChatMessage } from '$lib/types/chat-ui';

// LOS-174 (T1a): route the in-composer Talkback STT through the local Jetson
// STT WS bridge instead of the browser Web Speech API + AssemblyAI cloud
// fallback. Flip to `false` to restore the legacy browser/cloud path (kept
// intact behind this branch as rollback safety until on-device cutover is
// verified). Rollback = flip this flag OR revert the PR.
const TALKBACK_STT_VIA_BRIDGE = true;

// The page-owned reactive state the voice machine reads/writes. Reads are
// getters (so each call samples the live `$state`); writes are actions (so the
// page keeps ownership and its template bindings stay intact).
export interface VoiceDeps {
	getActiveThread: () => string;
	getSelectedRepo: () => string;
	getMessages: () => ChatMessage[];
	getAudioEl: () => HTMLAudioElement | null;
	getComposerMode: () => ComposerMode;
	setComposerMode: (mode: ComposerMode) => void;
	/** Re-focus the composer textarea after a dictation lands. */
	focusComposer: () => void;
	/** Append a server-returned row to the rendered feed (talkback dispatch). */
	appendMessage: (m: ChatMessage) => void;
	setCurrentTier: (tier: Tier) => void;
	setUserAtBottom: (atBottom: boolean) => void;
	/** Reconcile the feed against the DB (talkback reply polling). */
	pollMessages: () => Promise<void>;
	/**
	 * Surface-exclusion hook (LOS-176 / T1b): Talkback ⊻ full-voice. Reads the
	 * realtime full-voice overlay's open state so Talkback refuses to arm while
	 * full voice owns the screen. SURFACE-level only — it does not touch
	 * Talkback's own transport (`TALKBACK_STT_VIA_BRIDGE` / the STT bridge),
	 * which keeps gating itself. Optional so callers/tests without a full-voice
	 * surface (the loop never blocks) still construct cleanly.
	 */
	isFullVoiceActive?: () => boolean;
}

export interface VoiceController {
	/** Talkback loop running. Internal loop-control flag; exposed for tests. */
	readonly active: boolean;
	/** Current talkback phase (drives the Composer status strip). */
	readonly phase: TalkbackPhase | null;
	/** iOS audio-unlock blip — call on the first user gesture (also on send). */
	unlockAudio: () => void;
	/** Toggle the hands-free talkback loop. */
	toggleTalkback: () => Promise<void>;
	/** Stop talkback + release every device resource. `reason` toasts if set. */
	stopTalkback: (reason?: string) => Promise<void>;
	/** onDestroy hook — release everything. */
	destroy: () => Promise<void>;
}

// Talkback tuning constants.
const TALKBACK_SILENCE_AUTOSTOP_MS = 3 * 60 * 1000;
const TALKBACK_SILENCE_THRESHOLD = 0.01;
const TALKBACK_SILENCE_GATE_MS = 2500;
const TALKBACK_MAX_CAPTURE_MS = 30_000;

export function createVoiceController(deps: VoiceDeps): VoiceController {
	// ── Reactive UI state ───────────────────────────────────────────────
	let active = $state(false);
	let phase = $state<TalkbackPhase | null>(null);

	// ── Persistent-audio unlock (imperative) ────────────────────────────
	let audioUnlocked = false;

	// ── Talkback capture/transport (imperative) ─────────────────────────
	// LEGACY transport (reached ONLY when TALKBACK_STT_VIA_BRIDGE is false):
	// browser Web Speech API (primary) or MediaRecorder → async AssemblyAI
	// (fallback). Kept intact as rollback safety (LOS-174). AssemblyAI realtime
	// token endpoint returns 404 on the current plan as of 2026-05-28.
	let talkbackStream: MediaStream | null = null;
	let talkbackAudioCtx: AudioContext | null = null;
	let talkbackProcessor: ScriptProcessorNode | null = null;
	let talkbackWakeLock: WakeLockSentinel | null = null;
	let talkbackRecorder: MediaRecorder | null = null;
	let talkbackRecognition: SpeechRecognition | null = null;
	let talkbackTranscriptBuffer = '';
	let talkbackTtsAbortController: AbortController | null = null;
	let talkbackTtsUrl: string | null = null;
	let talkbackDispatchMsgId: number | null = null;
	let talkbackConsecutiveFailures = 0;
	let continuousSilenceMs = 0;

	// ── Jetson STT WS bridge transport (imperative; bridge-enabled path) ──
	// Session-level resources: opened once on toggle-on, reused across every
	// turn, torn down on stop. Deliberately SEPARATE from the legacy refs above
	// so the two transports never entangle.
	let talkbackWs: WebSocket | null = null;
	let talkbackMicStream: MediaStream | null = null;
	let talkbackMicCtx: AudioContext | null = null;
	let talkbackWorklet: AudioWorkletNode | null = null;
	let talkbackMicSource: MediaStreamAudioSourceNode | null = null;
	let talkbackStreaming = false; // gate: ship worklet PCM only while capturing
	let talkbackServicesStarted = false; // we started the on-demand GPU STT unit
	let talkbackWsPath = '/companion-voice';
	let talkbackFinalResolver: ((text: string) => void) | null = null;
	let talkbackLastVoiceTs = 0; // timestamp of last non-empty utterance (silence auto-stop)

	// ── Audio iOS workaround ─────────────────────────────────────────────
	function unlockAudio() {
		const audioEl = deps.getAudioEl();
		if (audioUnlocked || !audioEl) return;
		try {
			audioEl.src =
				'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
			void audioEl.play().catch(() => {});
			audioUnlocked = true;
		} catch {
			/* best effort */
		}
	}

	// ── Hands-free continuous Talkback loop ──────────────────────────────
	function pSleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	function playChime(): Promise<void> {
		return new Promise((done) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				done();
			};
			// The loop MUST advance even if the chime never fires `onended`. On iOS
			// an AudioContext created outside a user-gesture window comes back
			// suspended, so osc.onended never fires — which froze Talkback after the
			// first turn (the next capture was gated on this promise). The chime is a
			// nicety; never let it block the loop.
			const fallback = setTimeout(finish, 600);
			try {
				const ctx = new AudioContext();
				if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.connect(gain);
				gain.connect(ctx.destination);
				osc.type = 'sine';
				osc.frequency.value = 880;
				gain.gain.setValueAtTime(0.2, ctx.currentTime);
				gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
				osc.start(ctx.currentTime);
				osc.stop(ctx.currentTime + 0.25);
				osc.onended = () => {
					ctx.close().catch(() => {});
					clearTimeout(fallback);
					finish();
				};
			} catch {
				clearTimeout(fallback);
				finish();
			}
		});
	}

	// Revoke the in-flight TTS blob URL on EVERY teardown path, not just the
	// happy-path `onended`. Without this, stopping talkback early (manual stop,
	// stop-word, error streak, cap hit) or a playback error leaks a blob URL per
	// turn. (Pre-existed inline before this extraction; sealed here.)
	function revokeTtsUrl() {
		if (talkbackTtsUrl) {
			URL.revokeObjectURL(talkbackTtsUrl);
			talkbackTtsUrl = null;
		}
	}

	function talkbackStopCapture() {
		talkbackStream?.getTracks().forEach((t) => t.stop());
		talkbackStream = null;
		talkbackProcessor?.disconnect();
		talkbackProcessor = null;
		talkbackAudioCtx?.close().catch(() => {});
		talkbackAudioCtx = null;
		talkbackRecognition?.abort();
		talkbackRecognition = null;
		if (talkbackRecorder && talkbackRecorder.state !== 'inactive') {
			try {
				talkbackRecorder.stop();
			} catch {
				/* already stopped */
			}
		}
		talkbackRecorder = null;
	}

	async function stopTalkback(reason?: string) {
		active = false;
		deps.setComposerMode('idle');
		phase = null;
		talkbackDispatchMsgId = null;
		talkbackStopCapture();
		await teardownTalkbackBridge();
		talkbackTtsAbortController?.abort();
		talkbackTtsAbortController = null;
		const audioEl = deps.getAudioEl();
		if (audioEl && !audioEl.paused) {
			audioEl.pause();
			audioEl.currentTime = 0;
		}
		revokeTtsUrl();
		if (talkbackWakeLock) {
			await talkbackWakeLock.release().catch(() => {});
			talkbackWakeLock = null;
		}
		if (reason) toasts.add(reason, 'info');
	}

	async function toggleTalkback() {
		if (active) {
			// No toast on manual stop — the pill returns to idle, which is signal
			// enough. Auto-stop paths (cap hit, mic disconnected, error streak,
			// Jetson offline) still toast because their reason carries information
			// the operator needs.
			await stopTalkback();
			return;
		}
		// Surface exclusion (T1b): never arm Talkback while the full-voice overlay
		// owns the screen — it owns the mic. Toggling OFF above is unaffected.
		// This is a surface guard only; the STT bridge transport is untouched.
		if (deps.isFullVoiceActive?.()) return;
		unlockAudio();

		if (TALKBACK_STT_VIA_BRIDGE) {
			// Create the mic AudioContext IN the user gesture (synchronously) so iOS
			// unlocks it — any post-await creation loses the gesture and iOS refuses
			// to start audio. The mic/WS/service bring-up is async in
			// startTalkbackBridge below and reuses this context.
			try {
				talkbackMicCtx = talkbackMicCtx ?? new AudioContext();
				void talkbackMicCtx.resume();
			} catch {
				/* surfaced by startTalkbackBridge */
			}
			const ready = await startTalkbackBridge();
			// Jetson offline / mic denied / WS unreachable → an explicit error was
			// already toasted and the bridge torn down. Do NOT enter talkback: the
			// composer stays fully usable (no mode switch) and there is NO silent
			// cloud fallback.
			if (!ready) return;
		}

		try {
			if ('wakeLock' in navigator) {
				talkbackWakeLock = await (
					navigator as Navigator & {
						wakeLock: { request(type: string): Promise<WakeLockSentinel> };
					}
				).wakeLock.request('screen');
			}
		} catch {
			/* continuous without lock */
		}
		active = true;
		deps.setComposerMode('talkback');
		talkbackConsecutiveFailures = 0;
		continuousSilenceMs = 0;
		talkbackLastVoiceTs = Date.now();
		void beginTalkbackCapture();
	}

	// ── Jetson STT WS bridge transport (bridge-enabled path) ─────────────
	// Brings up the on-demand GPU STT service, the mic capture graph, and the
	// STT WebSocket. The on-demand `start` is ALSO the Jetson-readiness gate:
	// it returns not-ready when the speech service / Jetson is unreachable, which
	// is how "Jetson offline" becomes an explicit state instead of a silent cloud
	// fallback. Returns true once everything is live, false (already toasted +
	// torn down) on any failure.
	async function startTalkbackBridge(): Promise<boolean> {
		try {
			// 1. config — where the STT WS lives + whether voice is enabled.
			const cfgResp = await fetch(resolve('/api/chat/voice-config'));
			if (cfgResp.ok) {
				const cfg = (await cfgResp.json()) as { voiceEnabled?: boolean; wsPath?: string };
				if (cfg.voiceEnabled === false) {
					toasts.add('Voice is disabled.', 'error');
					return false;
				}
				talkbackWsPath = cfg.wsPath || talkbackWsPath;
			}

			// 2. start the on-demand speech service (cold GPU start may take a while)
			//    — and confirm it is actually READY (the Jetson-reachability gate).
			const ctl = await fetch(resolve('/api/chat/voice-control'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'start' })
			});
			const ctlBody = (await ctl.json().catch(() => ({}))) as { ready?: boolean };
			if (!ctl.ok || !ctlBody.ready) {
				toasts.add('Voice service offline — Talkback unavailable. You can still type.', 'error');
				return false;
			}
			talkbackServicesStarted = true;

			// 3. mic capture graph + 4. STT socket.
			await startTalkbackMic();
			await connectTalkbackWs();
			return true;
		} catch (e) {
			console.error('Talkback bridge start error:', e);
			toasts.add(
				'Could not reach the voice service — Talkback unavailable. You can still type.',
				'error'
			);
			await teardownTalkbackBridge();
			return false;
		}
	}

	async function startTalkbackMic() {
		talkbackMicStream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
		});
		if (!talkbackMicCtx) talkbackMicCtx = new AudioContext();
		await talkbackMicCtx.audioWorklet.addModule(`${base}/pcm-capture-worklet.js`);
		talkbackMicSource = talkbackMicCtx.createMediaStreamSource(talkbackMicStream);
		talkbackWorklet = new AudioWorkletNode(talkbackMicCtx, 'pcm-capture');
		talkbackWorklet.port.onmessage = (e: MessageEvent) => {
			// The worklet captures continuously; the `talkbackStreaming` gate decides
			// WHAT we ship — only during a capture turn, never while dispatching /
			// waiting / speaking (so the companion's own TTS isn't fed back in).
			if (talkbackStreaming && talkbackWs && talkbackWs.readyState === WebSocket.OPEN) {
				talkbackWs.send(e.data as ArrayBuffer);
			}
		};
		talkbackMicSource.connect(talkbackWorklet);
		// Silent (the worklet writes no output) — keeps the graph pulling so
		// process() runs on every browser.
		talkbackWorklet.connect(talkbackMicCtx.destination);
		talkbackMicStream.getTracks().forEach((track) => {
			track.onended = () => {
				if (active) void stopTalkback('Microphone disconnected — Talkback stopped');
			};
		});
	}

	function connectTalkbackWs(): Promise<void> {
		return new Promise((res, rej) => {
			const socket = new WebSocket(
				buildVoiceWsUrl(location.protocol, location.host, talkbackWsPath)
			);
			socket.binaryType = 'arraybuffer';
			talkbackWs = socket;
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
					// Server-side VAD endpoints each utterance (continuous), so a single
					// persistent socket serves every talkback turn.
					talkbackWsSend({
						type: 'config',
						sampleRate: talkbackMicCtx?.sampleRate ?? 48000,
						continuous: true
					});
					socket.onmessage = onTalkbackWsMessage;
					res();
					return;
				}
				onTalkbackWsMessage(ev);
			};
			socket.onerror = () => {
				if (!settled) {
					settled = true;
					clearTimeout(openTimer);
					rej(new Error('Could not reach the speech service.'));
				}
			};
			socket.onclose = () => {
				// A drop mid-session is an explicit failure — surface it, never fall
				// back to cloud STT.
				if (active) void failTalkback('Voice connection dropped — Talkback stopped');
			};
		});
	}

	function onTalkbackWsMessage(ev: MessageEvent) {
		const m = parseSttMessage(ev.data);
		switch (m.type) {
			case 'final':
				// Resolve the in-flight capture turn with the server's transcript.
				talkbackFinalResolver?.(m.text ?? '');
				break;
			case 'error':
				if (active) void failTalkback('Voice recognition error — Talkback stopped');
				break;
			// 'partial' / 'ready' / 'ignore' are not surfaced by the talkback strip.
		}
	}

	function talkbackWsSend(obj: Record<string, unknown>) {
		if (talkbackWs && talkbackWs.readyState === WebSocket.OPEN) {
			try {
				talkbackWs.send(JSON.stringify(obj));
			} catch {
				/* ignore — surfaces on the next send / onclose */
			}
		}
	}

	// One capture turn over the persistent bridge socket: reset the server
	// buffer, open the mic gate, and resolve with the server's `final` transcript
	// (or '' on the per-turn max-capture timeout). Sets `talkbackTranscriptBuffer`
	// for the shared post-processing in beginTalkbackCapture.
	function captureBridgeTranscript(): Promise<void> {
		return new Promise((resolveCapture) => {
			if (!active || !talkbackWs || talkbackWs.readyState !== WebSocket.OPEN) {
				resolveCapture();
				return;
			}
			// Hands-free silence auto-stop: nothing intelligible heard for the idle
			// window → stop (parity with the legacy path's 3-minute auto-stop).
			if (Date.now() - talkbackLastVoiceTs >= TALKBACK_SILENCE_AUTOSTOP_MS) {
				void stopTalkback('3 minutes of silence — Talkback auto-stopped');
				resolveCapture();
				return;
			}
			let settled = false;
			const finish = (text: string) => {
				if (settled) return;
				settled = true;
				talkbackStreaming = false;
				talkbackFinalResolver = null;
				if (text.trim()) talkbackLastVoiceTs = Date.now();
				talkbackTranscriptBuffer = text;
				resolveCapture();
			};
			// Per-turn cap: if server VAD never sends a `final` (e.g. pure silence),
			// resolve empty so the loop re-arms instead of hanging.
			const maxTimer = setTimeout(() => finish(''), TALKBACK_MAX_CAPTURE_MS);
			// A `final` from the WS clears the cap and finalizes the turn.
			talkbackFinalResolver = (text: string) => {
				clearTimeout(maxTimer);
				finish(text);
			};
			talkbackWsSend({ type: 'reset' });
			talkbackStreaming = true;
		});
	}

	// Explicit talkback failure: stop the loop and surface a clear message. NEVER
	// falls back to browser/cloud STT — that silent fallback is exactly what
	// LOS-174 removes.
	async function failTalkback(message: string) {
		await stopTalkback();
		toasts.add(message, 'error');
	}

	// Tear down every bridge-transport resource and stop the on-demand GPU STT
	// service if we started it. Safe to call when nothing is up (legacy path /
	// already torn down) — every ref is null-guarded.
	async function teardownTalkbackBridge() {
		talkbackStreaming = false;
		talkbackFinalResolver = null;
		if (talkbackWs) {
			talkbackWs.onmessage = null;
			talkbackWs.onerror = null;
			talkbackWs.onclose = null;
			try {
				talkbackWs.close();
			} catch {
				/* ignore */
			}
			talkbackWs = null;
		}
		if (talkbackWorklet) {
			talkbackWorklet.port.onmessage = null;
			try {
				talkbackWorklet.disconnect();
			} catch {
				/* ignore */
			}
			talkbackWorklet = null;
		}
		if (talkbackMicSource) {
			try {
				talkbackMicSource.disconnect();
			} catch {
				/* ignore */
			}
			talkbackMicSource = null;
		}
		talkbackMicStream?.getTracks().forEach((t) => t.stop());
		talkbackMicStream = null;
		if (talkbackMicCtx) {
			await talkbackMicCtx.close().catch(() => {});
			talkbackMicCtx = null;
		}
		if (talkbackServicesStarted) {
			// Free the GPU: stop the on-demand STT service we started on toggle-on.
			try {
				await fetch(resolve('/api/chat/voice-control'), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ action: 'stop' })
				});
			} catch {
				/* best effort */
			}
			talkbackServicesStarted = false;
		}
	}

	async function beginTalkbackCapture() {
		if (!active) return;
		phase = 'capture';
		talkbackTranscriptBuffer = '';

		try {
			// Acquire one utterance's transcript via the active transport. The
			// bridge path (default) goes through the Jetson STT WS; the legacy path
			// (flag off) uses the browser Web Speech API + AssemblyAI fallback.
			if (TALKBACK_STT_VIA_BRIDGE) {
				await captureBridgeTranscript();
			} else {
				await acquireTranscriptViaLegacy();
			}

			if (!active) return;

			// Stop-word check
			if (isTalkbackStopWord(talkbackTranscriptBuffer)) {
				await stopTalkback('Stop word detected — Talkback stopped');
				return;
			}

			const text = talkbackTranscriptBuffer.trim();
			if (!text) {
				// Nothing heard — loop immediately
				void beginTalkbackCapture();
				return;
			}

			await dispatchTalkback(text);
		} catch (e) {
			console.error('Talkback capture error:', e);
			talkbackStopCapture();
			talkbackConsecutiveFailures++;
			if (talkbackConsecutiveFailures >= 3) {
				await stopTalkback('3 consecutive errors — Talkback stopped');
				return;
			}
			toasts.add('Talkback error — retrying', 'error');
			if (active) await pSleep(500).then(() => beginTalkbackCapture());
		}
	}

	// LEGACY capture transport — reached ONLY when TALKBACK_STT_VIA_BRIDGE is
	// false (rollback safety, LOS-174). Browser Web Speech API (primary) or
	// MediaRecorder + async AssemblyAI (fallback); sets talkbackTranscriptBuffer.
	// DO NOT DELETE until the on-device Jetson-bridge cutover is verified.
	async function acquireTranscriptViaLegacy() {
		// Primary path: Web Speech API — browser-native, no API cost, works
		// with or without headphones (device echo cancellation handles speaker
		// feedback). Available on iOS Safari 14.5+, Chrome, Edge. Falls back to
		// MediaRecorder + async AssemblyAI transcription on unsupported browsers.
		const SpeechRecognitionCtor =
			typeof window !== 'undefined' &&
			((window as unknown as { SpeechRecognition?: new () => SpeechRecognition })
				.SpeechRecognition ||
				(window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition })
					.webkitSpeechRecognition);

		if (SpeechRecognitionCtor) {
			const recognition = new SpeechRecognitionCtor();
			talkbackRecognition = recognition;
			recognition.continuous = false;
			recognition.interimResults = false;
			recognition.lang = 'en-US';
			recognition.maxAlternatives = 1;

			const heardText = await new Promise<string>((res) => {
				let settled = false;
				const finish = (t: string) => {
					if (!settled) {
						settled = true;
						res(t);
					}
				};
				// Max capture guard
				const maxTimer = setTimeout(() => finish(''), TALKBACK_MAX_CAPTURE_MS);
				recognition.onresult = (e: SpeechRecognitionEvent) => {
					clearTimeout(maxTimer);
					finish(e.results[0][0].transcript);
				};
				recognition.onerror = () => {
					clearTimeout(maxTimer);
					// 'no-speech' and 'aborted' are not errors — just an empty turn
					finish('');
				};
				recognition.onend = () => {
					clearTimeout(maxTimer);
					finish('');
				};
				recognition.start();
			});

			talkbackRecognition = null;
			talkbackTranscriptBuffer = heardText;
		} else {
			// Fallback: MediaRecorder + VAD silence detection + async AssemblyAI
			await beginTalkbackCaptureViaMediaRecorder();
		}
	}

	// MediaRecorder fallback for browsers without Web Speech API. Records audio
	// into chunks, uses a ScriptProcessor for VAD (silence detection), then POSTs
	// the blob to the async AssemblyAI transcription endpoint when a pause is
	// detected. Works the same with/without headphones.
	async function beginTalkbackCaptureViaMediaRecorder() {
		talkbackStream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
		});
		talkbackStream.getTracks().forEach((track) => {
			track.onended = () => {
				if (active) void stopTalkback('Microphone disconnected — Talkback stopped');
			};
		});

		const chunks: BlobPart[] = [];
		const recorder = new MediaRecorder(talkbackStream);
		talkbackRecorder = recorder;
		recorder.ondataavailable = (e) => {
			if (e.data.size > 0) chunks.push(e.data);
		};

		// VAD via ScriptProcessor
		talkbackAudioCtx = new AudioContext({ sampleRate: 16000 });
		const source = talkbackAudioCtx.createMediaStreamSource(talkbackStream);
		talkbackProcessor = talkbackAudioCtx.createScriptProcessor(4096, 1, 1);
		source.connect(talkbackProcessor);
		talkbackProcessor.connect(talkbackAudioCtx.destination);

		let silenceStart: number | null = null;
		let hasVoice = false;

		await new Promise<void>((done) => {
			const maxTimer = setTimeout(done, TALKBACK_MAX_CAPTURE_MS);

			talkbackProcessor!.onaudioprocess = (e) => {
				if (!active) {
					clearTimeout(maxTimer);
					done();
					return;
				}
				const data = e.inputBuffer.getChannelData(0);
				let sum = 0;
				for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
				const rms = Math.sqrt(sum / data.length);
				const now = Date.now();

				if (rms >= TALKBACK_SILENCE_THRESHOLD) {
					silenceStart = null;
					hasVoice = true;
					continuousSilenceMs = 0;
				} else {
					if (silenceStart === null) silenceStart = now;
					continuousSilenceMs += (data.length / 16000) * 1000;
					if (continuousSilenceMs >= TALKBACK_SILENCE_AUTOSTOP_MS) {
						void stopTalkback('3 minutes of silence — Talkback auto-stopped');
						clearTimeout(maxTimer);
						done();
						return;
					}
					if (hasVoice && silenceStart !== null && now - silenceStart >= TALKBACK_SILENCE_GATE_MS) {
						clearTimeout(maxTimer);
						done();
					}
				}
			};
			recorder.start(100);
		});

		talkbackStopCapture();

		if (!hasVoice || !active || chunks.length === 0) return;

		phase = 'transcribe';
		const blob = new Blob(chunks, { type: 'audio/webm' });
		const fd = new FormData();
		fd.append('file', blob, 'talkback.webm');

		const resp = await fetch(resolve('/api/chat/transcribe'), { method: 'POST', body: fd });
		if (resp.ok) {
			const data = (await resp.json()) as { text?: string };
			talkbackTranscriptBuffer = data.text ?? '';
		} else if (resp.status === 429) {
			await stopTalkback('STT daily cap reached — Talkback stopped');
		}
		// Other errors fall through — talkbackTranscriptBuffer stays '' → loops silently
	}

	async function dispatchTalkback(text: string) {
		if (!active) return;
		phase = 'transcribe'; // visual bump to transcribing

		try {
			phase = 'dispatch';
			const resp = await fetch(resolve('/api/chat'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message: text,
					thread: deps.getActiveThread(),
					target_repo: deps.getSelectedRepo(),
					talkback: true // server overrides tier to Flash-lite
				})
			});
			if (!resp.ok) throw new Error(`Dispatch ${resp.status}`);

			const body = await resp.json();
			if (body.current_tier) deps.setCurrentTier(body.current_tier as Tier);
			const sentMsg = body.message as ChatMessage;
			deps.appendMessage(sentMsg);
			deps.setUserAtBottom(true);
			talkbackDispatchMsgId = sentMsg?.id ?? null;

			phase = 'speak';
			await waitForTalkbackReply();
		} catch (e) {
			console.error('Talkback dispatch error:', e);
			talkbackConsecutiveFailures++;
			if (talkbackConsecutiveFailures >= 3) {
				await stopTalkback('3 consecutive errors — Talkback stopped');
				return;
			}
			toasts.add('Talkback dispatch failed — retrying', 'error');
			if (active) void beginTalkbackCapture();
		}
	}

	async function waitForTalkbackReply() {
		if (!active || talkbackDispatchMsgId === null) return;
		const dispatchId = talkbackDispatchMsgId;
		const deadline = Date.now() + 90_000;

		while (Date.now() < deadline && active) {
			await deps.pollMessages();
			const reply = deps
				.getMessages()
				.find((m) => m.id > dispatchId && m.sender !== 'operator' && m.sender !== 'system');
			if (reply?.message) {
				talkbackDispatchMsgId = null;
				talkbackConsecutiveFailures = 0;
				await speakTalkbackReply(reply.message);
				return;
			}
			await pSleep(1200);
		}

		talkbackDispatchMsgId = null;
		if (!active) return;
		talkbackConsecutiveFailures++;
		if (talkbackConsecutiveFailures >= 3) {
			await stopTalkback('3 consecutive errors — Talkback stopped');
			return;
		}
		void beginTalkbackCapture();
	}

	async function speakTalkbackReply(text: string) {
		const audioEl = deps.getAudioEl();
		if (!active || !audioEl) return;
		talkbackTtsAbortController = new AbortController();

		try {
			const resp = await fetch(resolve('/api/chat/speak'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text }),
				signal: talkbackTtsAbortController.signal
			});
			if (resp.status === 429) {
				await stopTalkback('TTS cap hit — Talkback stopped');
				return;
			}
			if (!resp.ok) throw new Error(`TTS ${resp.status}`);

			const audioBlob = await resp.blob();
			revokeTtsUrl(); // drop any prior turn's URL before staging a new one
			const url = URL.createObjectURL(audioBlob);
			talkbackTtsUrl = url;
			audioEl.src = url;

			audioEl.onended = () => {
				if (talkbackTtsUrl === url) talkbackTtsUrl = null;
				URL.revokeObjectURL(url);
				if (active) {
					phase = 'loop';
					void playChime().then(() => {
						if (active) void beginTalkbackCapture();
					});
				}
			};
			audioEl.onerror = () => {
				if (talkbackTtsUrl === url) talkbackTtsUrl = null;
				URL.revokeObjectURL(url);
			};

			await audioEl.play();
		} catch (e) {
			if ((e as Error).name === 'AbortError') return;
			console.error('Talkback speak error:', e);
			talkbackTtsAbortController = null;
			talkbackConsecutiveFailures++;
			if (talkbackConsecutiveFailures >= 3) {
				await stopTalkback('3 consecutive errors — Talkback stopped');
				return;
			}
			if (active) void beginTalkbackCapture();
		} finally {
			talkbackTtsAbortController = null;
		}
	}

	return {
		get active() {
			return active;
		},
		get phase() {
			return phase;
		},
		unlockAudio,
		toggleTalkback,
		stopTalkback,
		destroy: () => stopTalkback()
	};
}
