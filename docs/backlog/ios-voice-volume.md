# iOS voice-mode volume control — PARKED

**Status:** Parked 2026-06-03 (operator deprioritized — "don't fiddle more for now").
**Priority:** Low. **Branch (attempts):** `fix/ios-voice-volume` (pushed, NOT merged).
**May be moot:** operator is investigating offloading voice-mode VRAM to a separate box; if the voice audio architecture changes, re-evaluate before resuming.

## The problem

On iPhone (Capacitor 8 + WKWebView loading the remote app), Sully's TTS audio does **not** respect the hardware volume — at zero volume she still plays. Goal: hardware volume (incl. zero/mute) controls TTS, and the mic (`getUserMedia`, voice + talkback) keeps working.

## What was tried (3 TestFlight builds)

The app sets `AVAudioSession` in `AppDelegate.didFinishLaunchingWithOptions` via `scripts/ci-ios-patch.sh` (injected every build, like the APNs patch).

| Build | Config                                                                   | Result                                                                                                                                             |
| ----- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15    | none (no AVAudioSession set)                                             | TTS ignores hardware volume (original bug).                                                                                                        |
| 16    | `.playAndRecord` + `.voiceChat` + `.defaultToSpeaker` + speaker override | Volume became controllable BUT bounced up a step at the bottom (never reached zero).                                                               |
| 17    | `.playAndRecord` + `.default` + …                                        | Still bounced at zero AND **broke talkback** (mic capture).                                                                                        |
| 18    | `.playback` + `.default`, no options, no override                        | Researched "correct" fix — but operator reports **volume issue still persists**. (Talkback likely restored by dropping `.playAndRecord`; confirm.) |

## Root cause (confirmed via research)

A persistent, app-owned **active `.playAndRecord` session** was wrong two ways:

1. iOS treats it as a **communication/"call" stream** → volume can't be muted to zero (snaps to a minimum). Mode-independent (`.voiceChat` and `.default` both did it).
2. It **collides with WKWebView's own AVAudioSession** management for `getUserMedia` ("multiple owners of the shared session") → broke mic capture (talkback).

The app should **not own a recording session** — WKWebView does that for `getUserMedia`.

## Open question after build 18

`.playback` is the textbook fix (normal media → obeys hardware volume incl. zero, doesn't break the mic), yet the operator says volume still isn't respected. Possible reasons to investigate:

- WKWebView's web process reconfigures the shared session for HTMLAudio/`getUserMedia` and **overrides** the AppDelegate launch-time category, so a launch-time set may simply not stick.
- The operator may have adjusted the **ringer** volume (vs media) when no audio was playing (iOS media-vs-ringer split) — verify by adjusting volume **while TTS is playing**.
- The TTS path might route through Web Audio (AudioContext) somewhere, not just HTMLAudio.

## Recommended next approach (when resumed)

1. **Confirm the current symptom precisely** on build 18: does volume change TTS at all? Adjust volume _while she's speaking_. Is talkback working again on build 18?
2. **Transient, on-demand session** (research "Option 2"): expose a tiny Capacitor plugin method to set `.playback` + `setActive(true)` **just before** TTS and `setActive(false, .notifyOthersOnDeactivation)` after — called from the web layer (voice client) around TTS playback, so it never fights WKWebView's `getUserMedia` session. This is the most surgical fix.
3. If WKWebView overrides everything, investigate whether the volume issue is actually the **media-vs-ringer** behavior (a usage/UX thing, not a bug) or needs a different audio path.
4. Re-evaluate entirely if voice VRAM moves to a separate box (audio architecture may change).

## Pointers

- `scripts/ci-ios-patch.sh` — the AppDelegate AVAudioSession injection (currently `.playback` on the `fix/ios-voice-volume` branch; **`main` has none** = build-15 behavior).
- `src/lib/chat/voice.svelte.ts` — TTS playback (`audioEl` HTMLAudioElement) + turn-based talkback capture.
- `tools/trigger-ios-build.sh [branch]` — triggers a Codemagic build; status via the Codemagic API (`CODEMAGIC_API_TOKEN` in `.env`).
- **`main` does NOT include the audio-session change** — a normal main build = known-good build-15 native behavior (talkback works, volume bug present). The operator's installed app is build 18 (`.playback`, branch-only).
