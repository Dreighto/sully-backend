# Sully Voice Pipeline Deep Audit — 2026-07-07

Fan-out workflow (10 agents: 3 research-digest + 3 pipeline-trace + 3 external-research + 1 synthesis).
Operator directive: voice is the cornerstone; root-cause, do not band-aid.

## Verdict
TWO SEPARATE bugs were being conflated:
1. **Reproducing `TimeoutError`** = cloud-LLM stall (`deepseek-v4-flash:cloud` on Ollama Pro) against the
   120s generation ceiling, with a FAIL-HARD / persist-nothing failure mode (server).
2. **"Cut off, then said something else"** = client-side FALSE BARGE-IN from broken AEC (iOS) — introduced/
   exposed by the b211 voice-activated barge-in. `.voiceChat` mode alone does NOT cancel Sully's TTS because
   capture + playback run on two separate AVAudioEngines and `setVoiceProcessingEnabled(true)` is never called.
   Leaked TTS -> STT partial >=3char -> performBargeIn (cut off) -> STT garbage final -> submitTurn (something else).
   The "regenerating fallback" hypothesis is REFUTED — no such path exists server- or client-side.

## Latency: LLM-bound. TTFA 1.06s (>700ms "broken" threshold), dominated by LLM queue/TTFT + STT endpointing.
TTS (Azure warm 0.3-0.6s) and STT (~300ms) are near-solved. prompt_eval of the augmented system prompt +
HISTORY=12 (both built INSIDE the timed window) inflate first-token.

## Decision: FIX-IN-PLACE now; defer SDK (LiveKit/Pipecat) to a data-gated Phase 2.
An SDK does nothing for a slow cloud model; the fix levers (enable AEC, gate barge-in, header idle-guard,
heartbeat) are afternoon-scale. Phase-2 trigger: if measured false-barge-in rate stays high after the AEC fix,
adopt LiveKit turn-detector v1-mini as a component.

## Prioritized actions
- **P0 #1 (iOS)** setVoiceProcessingEnabled(true) + route TTS into AEC reference path; gate barge-in:
  min-duration ~0.5s + min-words 1-3 + confidence + post-speaking cooldown ~300-500ms; kill the 3-char
  partial trigger; require formatted final before submitTurn. FILES: RealtimeVoiceController.swift:142-149,203-215;
  VoiceMicStreamer, GaplessWAVPlayer.
- **P0 #2 (backend)** header idle-guard (~20-30s, not 120s) + SSE `: ping` heartbeat every ~1s during generation.
  FILES: voice_stream.ts:240; voice_reply_stream.ts.
- **P1 #3** persist-on-failure (heardPrefixFromLog), no regenerate. voice_reply_stream.ts:122; iOS startVoiceReply catch.
- **P1 #4** cut LLM TTFT: trim HISTORY, prewarm/cache augmented prompt, build before t0.
- **P2 #5** diagnose Ollama-Pro stalls (log first_token_ms/prompt_eval_ms; warm-retry / faster fallback model).
- **P2 #6** iOS voice URLSession explicit timeouts + stopAndClearQueue on error.
- **P2 #7** TTS drainer/undici pool: drain every body, silence-placeholder on audio_error.
- **P3 #8** filler-then-answer caption contract; **P3 #9** STT double-final handling.
- Noted build-192 bugs (separate): mute-button inverted, tool-result JSON spoken aloud, Talkback hardcoded to Kokoro.
