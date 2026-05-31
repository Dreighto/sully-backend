// Voice / talkback state machine — extracted from chat/+page.svelte (cleanup ③
// slice 3c). Owns three cohesive concerns:
//   1. iOS audio-unlock workaround (a muted blip on first user gesture so the
//      persistent <audio> element is allowed to play TTS later).
//   2. One-shot mic dictation (MediaRecorder → /api/chat/transcribe → composer
//      draft).
//   3. The hands-free continuous "Talkback" loop: capture (Web Speech API
//      primary, MediaRecorder + VAD + async transcription fallback) → dispatch
//      → wait for reply → speak (TTS) → chime → loop.
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

import { resolve } from '$app/paths';
import { toasts } from '$lib/utils/toasts';
import type { Tier, ComposerMode, TalkbackPhase, ChatMessage } from '$lib/types/chat-ui';

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
	/** Append dictated text to the composer draft (one-shot mic). */
	appendDictation: (text: string) => void;
	/** Re-focus the composer textarea after a dictation lands. */
	focusComposer: () => void;
	/** Append a server-returned row to the rendered feed (talkback dispatch). */
	appendMessage: (m: ChatMessage) => void;
	setCurrentTier: (tier: Tier) => void;
	setUserAtBottom: (atBottom: boolean) => void;
	/** Reconcile the feed against the DB (talkback reply polling). */
	pollMessages: () => Promise<void>;
}

export interface VoiceController {
	/** Talkback loop running. Internal loop-control flag; exposed for tests. */
	readonly active: boolean;
	/** Current talkback phase (drives the Composer status strip). */
	readonly phase: TalkbackPhase | null;
	/** iOS audio-unlock blip — call on the first user gesture (also on send). */
	unlockAudio: () => void;
	/** Toggle one-shot mic dictation. */
	toggleRecord: () => Promise<void>;
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

	// ── One-shot dictation (imperative) ─────────────────────────────────
	let mediaRecorder: MediaRecorder | null = null;
	let recordChunks: Blob[] = [];

	// ── Persistent-audio unlock (imperative) ────────────────────────────
	let audioUnlocked = false;

	// ── Talkback capture/transport (imperative) ─────────────────────────
	// WebSocket path removed — talkback uses Web Speech API (primary) or
	// MediaRecorder → async AssemblyAI (fallback). Both work with/without
	// headphones via browser echo cancellation. AssemblyAI realtime token
	// endpoint returns 404 on the current plan as of 2026-05-28.
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

	// ── Voice dictation (Mic button — one-shot) ─────────────────────────
	async function toggleRecord() {
		unlockAudio();
		if (deps.getComposerMode() === 'recording') {
			mediaRecorder?.stop();
			return;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true }
			});
			recordChunks = [];
			mediaRecorder = new MediaRecorder(stream);
			mediaRecorder.ondataavailable = (e) => {
				if (e.data.size > 0) recordChunks.push(e.data);
			};
			mediaRecorder.onstop = async () => {
				deps.setComposerMode('idle');
				stream.getTracks().forEach((t) => t.stop());
				const blob = new Blob(recordChunks, { type: 'audio/webm' });
				const fd = new FormData();
				fd.append('file', blob, 'rec.webm');
				try {
					const r = await fetch(resolve('/api/chat/transcribe'), { method: 'POST', body: fd });
					if (!r.ok) {
						toasts.add('Transcription failed', 'error');
						return;
					}
					const b = await r.json();
					if (b.text) {
						deps.appendDictation(b.text);
						deps.focusComposer();
					}
				} catch {
					toasts.add('Transcription service unreachable', 'error');
				}
			};
			mediaRecorder.start();
			deps.setComposerMode('recording');
		} catch {
			toasts.add('Microphone permission denied', 'error');
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
			// enough. Auto-stop paths (cap hit, mic disconnected, error streak)
			// still toast because their reason carries information the operator
			// needs.
			await stopTalkback();
			return;
		}
		unlockAudio();
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
		void beginTalkbackCapture();
	}

	async function beginTalkbackCapture() {
		if (!active) return;
		phase = 'capture';
		talkbackTranscriptBuffer = '';

		try {
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

			if (!active) return;

			// Stop-word check
			const lower = talkbackTranscriptBuffer.toLowerCase();
			if (lower.includes('stop talkback') || lower.includes('cancel talkback')) {
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
		toggleRecord,
		toggleTalkback,
		stopTalkback,
		destroy: () => stopTalkback()
	};
}
