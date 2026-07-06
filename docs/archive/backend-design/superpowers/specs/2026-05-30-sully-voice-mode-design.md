# Sully Voice Mode — Fixes, Local Voices & Latency (Design)

**Date:** 2026-05-30 · **Author:** CC · **Status:** Shape approved by operator; spec under review
**Related:** `2026-05-30-sully-companion-rebuild-design.md`, memory `project_companion_voice_mode`, `project_companion_repos`

## Goal

Make Sully's voice a polished daily driver. Bring **both** voice surfaces — Talkback (on-chat headphones loop) and full-screen Voice Mode (immersive) — to a quality the operator can test side-by-side, then pick a daily driver. Both voices (Emma, Goodman) run **locally**; tune latency now that they're local.

## Current state (verified by code investigation)

Two separate voice systems exist:

- **Talkback** — `src/lib/chat/voice.svelte.ts` (mic/headphones button). Browser **Web Speech API** STT + **ElevenLabs** TTS (`/api/chat/speak`). Waits for the **full** reply, then speaks (batch). **Bug:** works on turn 1, then hangs / slow to send on later turns.
- **Full-screen Voice Mode** — `src/lib/chat/realtime-voice.svelte.ts` (audio-lines button). Server **Silero-VAD** STT (`companion-speech/stt_server.py`, :18770) + routed TTS (cloud Emma → local fallback via `src/lib/server/voices.ts`). **Streams** sentence-by-sentence; barge-in works. This is where the local **Goodman** voice, the **"scary noises"**, and the **0.8 s turn-cutoff** live.

Local TTS = **Chatterbox** on GPU (`companion-speech/tts_server.py`, :18771), zero-shot cloning from reference clips: `voices/sully_goodman.wav` (active) + `voices/emma.mp3` (available). Tunable knobs: `TTS_TEMPERATURE`=0.8, `TTS_CFG_WEIGHT`=0.5, `TTS_EXAGGERATION`=0.5, `TTS_VOICE_REF`. Turn-taking knobs (STT): `STT_VAD_SILENCE_MS`=800, `STT_VAD_THRESHOLD`=0.6, `STT_VAD_MIN_SPEECH_MS`=350.

## Decisions (from brainstorm)

1. **Both voices local.** Emma becomes a local Chatterbox clone (reference = `voices/emma.mp3`), alongside Goodman.
2. **ElevenLabs off, not deleted.** Default everything local (`VOICE_TTS_PROVIDER=local`); keep the ElevenLabs path so we can A/B Emma-local vs Emma-cloud by ear. Reversible.
3. **Unify on the local engine.** Both modes call local Chatterbox; tune the engine once → both modes and both voices benefit.
4. **Operator picks the daily driver** after testing both.

## Workstreams

### A. Shared local-engine tuning (helps both modes)

- **Anti-glitch ("scary noises"):** lower `TTS_TEMPERATURE` (0.8 → ~0.6); normalize text before synthesis (expand/strip bare numbers, URLs, code, stray symbols); enforce a minimum chunk length so tiny fragments (e.g. `"v1."`) aren't synthesized alone. Confirm the exact trigger with a repro pass (adversarial inputs).
- **Latency:** keep the model resident/warm (already is); cut first-sentence latency (smaller first chunk and/or a warm ping when a voice session opens). Going local already removes the ElevenLabs network round-trip.

### B. Full-screen Voice Mode

- Make Emma + Goodman local and selectable.
- **Turn-taking patience** (the "cuts me off"): raise `STT_VAD_SILENCE_MS` (800 → ~1300, then tune by ear); revisit `STT_VAD_THRESHOLD` / `STT_VAD_MIN_SPEECH_MS` only if needed. This mode has the precise dials.
- Shave first-word latency (shared tuning, item A).

### C. Talkback

- **Fix the hang-after-first-turn.** Root cause class = turn-1 state not reset for turn 2. Top suspects (ranked): (1) `playChime()` oscillator `onended` never fires → loop never re-arms; (2) `audioEl.play()` promise hangs; (3) Web Speech `recognition.start()` hangs with no prior `abort()`. Fix: explicit per-turn reset + timeouts so no single await can freeze the loop.
- **Switch TTS to local** (`/api/chat/speak` ElevenLabs → local Chatterbox).
- **Stream sentence-by-sentence** (today it waits for the whole reply → feels slow). Largest single change in this plan.
- Note: Talkback's end-of-speech detection is the browser's Web Speech API — inherently **less tunable** than full-screen's server VAD.

## Out of scope (tracked separately)

- Sully-as-dispatcher "Working bubble" (own design cycle; ~55% already built).
- Frontend rebuild (last, per operator).

## Risks / open items

- Local Emma will be _our clone_, not the polished ElevenLabs original — quality acceptance is by-ear; the anti-glitch work (item A) applies to her too.
- Exact patience (`STT_VAD_SILENCE_MS`) and `TTS_TEMPERATURE` are tune-by-ear during implementation.
- Talkback streaming is the heaviest change; if it balloons, reconsider whether Talkback stays a daily-driver candidate.

## Verification plan

- Per-mode manual test on the operator's iPhone with the Soundcore Liberty 4 Pro earbuds.
- Anti-glitch: adversarial prompts (numbers, URLs, abbreviations, very short replies) → no artifacts.
- Latency: measure time-to-first-word in both modes, local.
- Turn-taking: confirm the operator can pause mid-thought without being cut off.
