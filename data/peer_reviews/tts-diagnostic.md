# Sully Voice Latency Diagnostic

**Generated:** 2026-06-03 20:10 UTC  
**Tested by:** CC (VP Ops)

---

## TL;DR

The 15–40 second delay you hear before you can talk is **not** ElevenLabs being slow. ElevenLabs averages 315ms per sentence — it's fast. The bottleneck is the **Chatterbox TTS GPU model cold-start** that fires every single time you open Voice Mode. It takes ~21 seconds to load on the GPU, and the app won't let you talk until both STT and TTS are ready — even though Chatterbox is only a fallback and ElevenLabs is doing all the actual speaking.

---

## Service Configuration

| Item                   | Value                                                    |
| ---------------------- | -------------------------------------------------------- |
| **Primary TTS**        | ElevenLabs Flash (cloud API)                             |
| **Voice**              | Emma — voice ID `56bWURjYFHyYyVf490Dp`                   |
| **ElevenLabs model**   | `eleven_flash_v2_5`                                      |
| **Fallback TTS**       | Chatterbox (local GPU, :18771)                           |
| **Fallback voice**     | `emma.mp3` reference clip                                |
| **STT**                | faster-whisper `small.en` (local GPU, :18770, WS)        |
| **Realtime STT model** | `tiny.en` (captions only)                                |
| **LLM**                | companion-v1-voice via Ollama (local GPU)                |
| **On-demand behavior** | Both STT + TTS started on `enter()`, stopped on `exit()` |

### Where it's configured

- `src/lib/server/voices.ts` — voice catalog (Emma = ElevenLabs, Sulley = Chatterbox)
- `src/lib/server/voice_services.ts` — startup/shutdown logic and ready-wait
- `companion-speech/tts_server.py` — Chatterbox HTTP server (port 18771)
- `companion-speech/stt_server.py` — faster-whisper WS server (port 18770)
- `.env` → `VOICE_TTS_PROVIDER=elevenlabs`

---

## Latency Measurements

### Test 1: ElevenLabs TTS (5 runs)

Endpoint: `POST /companion/api/chat/speak`  
Text: "Hello, I am Sully. The weather today is looking quite pleasant."  
Voice: `emma` → `eleven_flash_v2_5`

| Run     | Time (ms) | HTTP | Bytes  |
| ------- | --------- | ---- | ------ |
| 1       | 373       | 200  | 50,199 |
| 2       | 297       | 200  | 52,288 |
| 3       | 298       | 200  | 51,453 |
| 4       | 291       | 200  | 47,691 |
| 5       | 316       | 200  | 58,140 |
| **Avg** | **315**   |      |        |

**ElevenLabs is not the problem.** 315ms per sentence is fast and consistent.

### Test 2: LLM Voice-Reply (3 runs)

Endpoint: `POST /companion/api/chat/voice-reply`  
Model: companion-v1-voice (Ollama, local GPU)

| Run     | Time (ms) | Response                                                 |
| ------- | --------- | -------------------------------------------------------- |
| 1       | 4,612     | "I'm doing well, thanks for asking. How about yourself?" |
| 2       | 4,558     | "I'm good, thanks. What's up with you?"                  |
| 3       | 5,263     | "I'm here and ready to help. What's on your mind?"       |
| **Avg** | **4,811** |                                                          |

LLM inference is ~5 seconds. That's real latency but not the 15–40s gap you're hitting.

### Test 3: Service Cold-Start (empirical, from systemd journal)

Measured from `journalctl` against this morning's actual start:

| Service                                 | systemd start | Process ready | **Cold-start**  |
| --------------------------------------- | ------------- | ------------- | --------------- |
| STT (faster-whisper small.en + tiny.en) | 13:03:11      | 13:03:16      | **~5 seconds**  |
| TTS (Chatterbox GPU model)              | 13:03:11      | 13:03:32      | **~21 seconds** |

`startVoiceServices()` starts both in parallel and polls until BOTH are ready. The TTS is the slow one — it controls the gate. The app blocks at `servicesReady = false` until both pass the health check, which means **every Voice Mode open costs ~21 seconds before you can speak**.

---

## Root Cause

```
voice_services.ts — START_TIMEOUT_MS = 40000
// Wait for models to load + ports to bind (cold start ~10-20s on the GPU).
```

Every `enter()` call:

1. Starts `logueos-companion-stt` (~5s to ready)
2. Starts `logueos-companion-tts` (Chatterbox, **~21s to ready**)
3. Polls both until healthy — blocks `servicesReady` the entire time
4. Only then connects the WebSocket and lets you speak

The Chatterbox TTS service loads a diffusion model onto the GPU on cold start. That's the 21 seconds. And it's loading for a job it may never do — because ElevenLabs is handling all TTS when the daily cap isn't hit, which is almost always.

**Per-turn latency once warm** (not the big number, but real):

- STT transcription: fast (tiny.en realtime model running continuously)
- LLM inference: ~4.8s average
- ElevenLabs TTS per sentence: ~315ms
- Total per turn: ~5–7 seconds (first sentence starts playing before reply is done)

---

## Where the 15–40s Is Coming From

| Component                          | Latency | Always hits?                                    |
| ---------------------------------- | ------- | ----------------------------------------------- |
| TTS cold-start (Chatterbox)        | ~21s    | Every Voice Mode open                           |
| STT cold-start (faster-whisper)    | ~5s     | Every Voice Mode open (parallel, masked by TTS) |
| LLM inference (companion-v1-voice) | ~5s     | Every turn                                      |
| ElevenLabs TTS per sentence        | ~315ms  | Every turn                                      |

The "good run" 15s likely includes only the STT cold-start (TTS was already warm from a prior session or the STT port was already bound). The 30–40s runs are full cold-starts of both.

---

## Recommended Fixes (in order of impact)

### Fix 1: Skip TTS cold-start when ElevenLabs is primary (saves ~16s)

In `src/lib/server/voice_services.ts`, import `cloudAvailable()` from `voices.ts` and only start the TTS service when it'll actually be needed:

```typescript
// Current: always starts both
await Promise.all([systemctl('start', STT_UNIT), systemctl('start', TTS_UNIT)]);

// Fixed: skip Chatterbox startup when ElevenLabs is configured and cap isn't hit
const needLocalTts = !cloudAvailable();
const starts: Promise<string>[] = [systemctl('start', STT_UNIT)];
if (needLocalTts) starts.push(systemctl('start', TTS_UNIT));
await Promise.all(starts);
```

Similarly, the ready-check should skip the TTS health probe when Chatterbox isn't needed. This alone cuts the 21s startup to ~5s (STT only).

### Fix 2: Keep services alive across sessions with an idle timeout

Instead of `stopVoiceServices()` on every `exit()`, hold a keep-alive timer. If no voice session opens within N minutes, then tear down. This eliminates cold-starts entirely during an active Sully work session.

```typescript
// In voice_services.ts — a lazy teardown pattern
let teardownTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleVoiceShutdown(delayMs = 10 * 60 * 1000) {
	if (teardownTimer) clearTimeout(teardownTimer);
	teardownTimer = setTimeout(() => stopVoiceServices(), delayMs);
}
// Call scheduleVoiceShutdown() in exit() instead of stopVoiceServices() directly
```

### Fix 3: Pre-warm STT in the background on app start (saves STT portion)

The STT model (faster-whisper small.en) takes ~5s and could be pre-loaded in the background when the companion app starts, rather than waiting for the first `enter()`. Chatterbox is heavier and better left on-demand.

---

## What This Isn't

- **Not an ElevenLabs problem** — 315ms is excellent for cloud TTS
- **Not a GPU contention issue** (unless companion-v1-voice and Chatterbox are fighting for VRAM simultaneously, which only happens if ElevenLabs caps out mid-session)
- **Not a network issue** — ElevenLabs latency is steady across 5 runs with no jitter

---

## Quick Sanity Check Before Fixing

Run this to confirm ElevenLabs isn't hitting the daily cap (cap exhaustion would force fallback to Chatterbox and mask it as "slow TTS"):

```bash
curl -s http://localhost:18769/companion/api/chat/speak/status
```

If it returns `cap_exhausted`, change `ELEVENLABS_DAILY_CHAR_CAP` in `.env` or set `VOICE_TTS_PROVIDER=local` intentionally. If it 404s, the status route may need to be added — check today's usage in the DB directly.
