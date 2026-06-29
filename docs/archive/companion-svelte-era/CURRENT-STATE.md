# Sully (LogueOS-Companion) — Current State

> _Last updated: 2026-06-04 · branch `main` @ `2510436` · all services live · 214/214 tests pass · type-check clean (0 errors)_
>
> This is the "what Sully actually is right now" doc, grounded in the 2026-06-02 audit + verified live state — not memory. See also [DOING-NOW.md](DOING-NOW.md) and [PLAN.md](PLAN.md).

## What it is

Sully is **dreighto's personal local-model chat companion** — a SvelteKit (adapter-node) app that runs on the dev box (`:18769`), fronted on the tailnet at `https://room.taila28611.ts.net:8444/companion`, with a thin **Capacitor iOS shell** on TestFlight. It started as a fork of LogueOS-Console and is the operator's **active focus project**. ~149 source files: 56 server modules, 16 components, 38 API routes, 26 test files.

## Where you can use it

| Surface                                                                                                                                                                                          | State                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **iPhone (TestFlight app)**                                                                                                                                                                      | Build **15** live — loads the remote server over Tailscale; mic + **push notifications** working end-to-end |
| **Desktop browser**                                                                                                                                                                              | `…:8444/companion/chat` (or `127.0.0.1:18769` locally)                                                      |
| The app is a **thin shell**: it loads the remote SvelteKit server at runtime; nothing is bundled, so server-side changes reach the app on reload (no rebuild needed unless native code changes). |

## What works today (verified this session)

- **Chat** — cloud models (Gemini, GPT-OSS via Ollama Cloud) + local models; per-thread, with a model/tier picker. Replies stream via the Vercel AI SDK.
- **Task-first journal (Phase 1)** — every turn becomes a Task with a forensic journal (`task_proposed → classifier_ran → reply_persisted → gate_evaluated`) + per-message forensics (model/provider/tokens/latency). Readable via `turn_replay.ts`.
- **Dispatch to workers — propose → confirm → seamless Task card → synthesized result.** Sully PROPOSES work (no `@cc`/`@agy` needed) and dispatches only on confirm: tap **Run it / Not now** (brand fuchsia pills) or say "yes". `@cc`/`@agy` still force it. The hand-off renders as ONE morphing card (calm working pulse → `✓ CC handled this · Ns` strip above the answer) — no stuck timer, no raw events leaking. The finished worker result comes back as a **plain-English summary in Sully's voice** (Phase 3 synthesis, Haiku). Proven live end-to-end (operator-run repo audit). Routing decided by a pure `decide()` graded by a **hard CI scorecard gate**.
- **Voice Mode (realtime)** — local-GPU STT (faster-whisper) → reply → TTS, immersive UI, hands-free/PTT, barge-in, on-demand GPU.
- **Read-aloud / Talkback** — per-message TTS in chat. Now uses **cloud Emma** (ElevenLabs Flash, ~0.6 s) as primary with local Chatterbox fall-forward.
- **Push notifications (APNs)** — native iOS push; task-completion pings the lock screen. Verified end-to-end (test push received).
- **Image generation** — Gemini image mode in the composer.
- **Web tools** — web_search / web_fetch via Ollama Pro (primary) → Perplexity → Firecrawl, in both text and voice.

## How it's wired (architecture map)

**Boot:** `src/hooks.server.ts` → `bootstrapCompanionDb()` (creates tables + additive migrations) → conditionally starts the completion poller. `config.ts` is the single source of run-mode coupling — a `runMode` boolean matrix derived from `LOGUEOS_APP_MODE` (fail-closed default-wired), read as named booleans everywhere. **This is the cleanest part of the codebase; leave it intact.**

**Chat turn pipeline:** two live entry points —

- **Modern:** `api/chat/sdk-stream/+server.ts` → delegates to `chat/stream_prepare.ts` (persist → classify → hot-window assembly → model resolve → tool gating → system prompt) then `chat/autonomous_dispatch.ts` for post-reply dispatch. Clean.
- **Legacy:** `api/chat/+server.ts` POST — a ~530-line god-handler with 5 branches; **stuck half-migrated** (see PLAN.md — it's the source of the highest-severity bugs).
- **Voice:** `api/chat/voice-reply/+server.ts` reuses the shared `chat_turn.ts` services.
- Shared single-source services (deliberately extracted to stop drift): `chat_turn.ts`, `chat_prompt.ts`, `stream_prepare.ts`, `model_catalog.ts`.

**Frontend:** `routes/chat/+page.svelte` (the surface) + `lib/components/` (MessageFeed, Composer, VoiceMode, …) + rune controllers in `lib/chat/*.svelte.ts` (message-actions, voice, streaming, realtime-voice). State is page-owned, reached by controllers through a deps port.

**Data layer:** SQLite (`data/companion.db`, WAL). ⚠️ ~23 modules each open their own connection per call — see known debt.

**Dispatch / task-first:** `decisionGate.ts` (ruleGate `@cc`/`@agy` force + valueGate heuristics) → `autonomous_dispatch.ts` → `companionDispatch.ts` (HMAC to the dispatch listener) OR the legacy gateway HTTP path. FSM in `dispatchJobs.ts`; journal in `chatActivity.ts`.

**Voice stack:** `voice_services.ts` (on-demand GPU lifecycle + self-heal), `voices.ts` (cloud/local routing), `speak`/`speak-local` routes, `wav_pad.ts` (iOS clip fix). Python STT/TTS services on `:18770`/`:18771`.

**Build/iOS/push:** `codemagic.yaml` regenerates `ios/` every build; `scripts/ci-ios-patch.sh` injects entitlement + AppDelegate push forwarding; stable signing key injected via `tools/trigger-ios-build.sh`; `apns.ts` is a zero-dep APNs sender.

## Health & known debt

- ✅ **Quality gate now live** — `.github/workflows/ci.yml` runs type-check + 214 tests on every push; a **routing scorecard** is a hard gate (`npm run routing:score`).
- ✅ **Resolved (this session):** Sully's dispatch judgment is no longer silently vetoed by a keyword regex — routing is now a pure `decide()` (Talk/Ask/Dispatch) and she proposes-then-confirms. Completion routing/idempotency, the stuck-card timer, and the raw-event leak are fixed.
- 🟡 **Known structural debt** (full detail + file:line in `data/peer_reviews/2026-06-02_companion-audit_findings.md`): the half-migrated legacy `/api/chat` handler; ~23 per-call DB connections (no shared pool/busy_timeout); two voice subsystems with duplicated playback; usage counters that only count cloud; **no verification stage** (worker "done" trusted blindly — Phase 4); **no workspace/write-tool** (blocks "Today's Ops").
- 🟢 The quick-win batch (`11f466e`) already cleared: a latent index bug, a type error, a wrong-thread history bug, trace-ID collisions, the APNs key-cache, the Enter-to-send hotkey, and ~4 dead modules.

## Pointers

- Full audit: `data/peer_reviews/2026-06-02_companion-audit_findings.md`
- Today's Ops design: `data/peer_reviews/2026-06-02_todays-ops-data-sources_design.md`
- What's in flight: [DOING-NOW.md](DOING-NOW.md) · What's next: [PLAN.md](PLAN.md)
