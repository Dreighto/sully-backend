# Codex Peer Review: Refactor Proposal for LogueOS-Companion

Date: 2026-05-30
Reviewer: Codex
Repo: `/home/dreighto/dev/LogueOS-Companion`

## Plain-English Summary

LogueOS-Companion is functional enough to keep iterating, but it still carries a lot of cloned Console structure. The highest-value refactor is not a visual rewrite. It is to split the chat surface into testable feature controllers and server services so the companion can stay local-first, voice-first, and kernel-off safe without every change touching the same 1,700-line page and two overloaded API routes.

Recommended order:

1. Extract client chat orchestration out of `src/routes/chat/+page.svelte`.
2. Split `POST /api/chat` and `POST /api/chat/sdk-stream` into shared server services.
3. Consolidate provider/model routing into one module.
4. Move voice lifecycle and health logic behind a dedicated voice service abstraction.
5. Add focused regression tests for mode gates, message persistence, routing, and voice service control.

## Current State

The repo appears to be a successful clone-then-fork of the Console chat surface:

- `npm run check` passes with 0 Svelte diagnostics.
- `src/lib/server/config.ts` already has a good central `runMode` gate for companion vs wired behavior.
- `src/lib/server/bootstrap.ts` correctly handles the fresh companion DB gap for `chat_messages` and `chat_user_state`.
- The new realtime voice path is present in `src/lib/chat/realtime-voice.svelte.ts` and the local voice endpoints.
- The app has no repo-local `AGENTS.md` or `CLAUDE.md`, so the umbrella LogueOS rules are the only local operating rules I found.

Current rough size hotspots:

- `src/routes/chat/+page.svelte`: 1,767 LOC
- `src/routes/api/chat/sdk-stream/+server.ts`: 651 LOC
- `src/routes/api/chat/+server.ts`: 593 LOC
- `src/lib/components/Markdown.svelte`: 518 LOC
- `src/lib/components/Composer.svelte`: 409 LOC

Verification notes:

- `npm run check`: PASS
- `npm run lint`: FAILS at Prettier check before ESLint runs; 39 files need formatting. I did not run `prettier --write` because this review should stay proposal-only.

## Main Refactor Thesis

The companion has crossed the point where "copy and patch" is the right shape. The next failure mode will be behavioral drift: streaming, non-streaming chat, image generation, dispatch fallback, talkback, realtime voice, tier state, thread state, and model routing all update the same persistence tables through slightly different paths.

The refactor should preserve behavior while reducing the number of places that can invent their own route, prompt, model, or persistence semantics.

## Findings

### 1. `+page.svelte` still owns too many unrelated behaviors

Evidence:

- SDK transport and stream state live in `src/routes/chat/+page.svelte:188`.
- Send routing, optimistic message insertion, image/dispatch branching, and attachment folding live in `src/routes/chat/+page.svelte:529`.
- Stream error mapping and reconciliation live in `src/routes/chat/+page.svelte:765`.
- Upload staging lives in `src/routes/chat/+page.svelte:827`.
- Local storage unlock state and timers live in `src/routes/chat/+page.svelte:1345`.

Why it matters:

Any UI change can accidentally affect message send, stream reconciliation, attachment persistence, tool unlock headers, thread switching, or polling. This makes CC review harder because the blast radius is hidden inside one component.

Proposal:

Create a client orchestration layer under `src/lib/chat/`:

- `streaming.svelte.ts`: owns `Chat`, `DefaultChatTransport`, placeholder row, stream mirroring, error mapping, and final `pollMessages`.
- `composer-state.svelte.ts`: owns draft, attachments, paste-to-attachment, upload staging, and send readiness.
- `threads.svelte.ts`: owns thread switching, slug generation, rename/archive/delete/pin, and URL sync.
- `slash-commands.ts`: plain command registry, with page-provided ports for side effects.
- Keep `+page.svelte` as composition and markup only.

Target result:

- `src/routes/chat/+page.svelte` below roughly 900 LOC.
- All network-heavy client behavior callable from small controller tests or Playwright harnesses.

### 2. Two chat POST routes duplicate routing and persistence responsibility

Evidence:

- Legacy/non-streaming route persists the operator message, classifies tier, updates thread meta, dispatches workers, calls Hermes, calls image generation, and calls the old LLM router in `src/routes/api/chat/+server.ts:120`.
- SDK streaming route also persists the operator message, classifies tier, updates thread meta, resolves provider/model, builds a system prompt, and persists the assistant row in `src/routes/api/chat/sdk-stream/+server.ts:373`.
- Both routes have their own prompt builders: `src/routes/api/chat/+server.ts:23` and `src/routes/api/chat/sdk-stream/+server.ts:264`.

Why it matters:

This is the largest source of future companion drift. A fix to classification, model selection, thread state, prompt wording, context reset slicing, or persistence has to be remembered in two places. The companion will eventually show different behavior depending on whether the user hit the streaming path, image path, talkback path, or dispatch path.

Proposal:

Create server services:

- `src/lib/server/chat_turn.ts`
  - `persistUserTurn({ text, threadId, sender, ticketId })`
  - `classifyAndTouchThread({ threadId, userText })`
  - `buildRecentHistory({ threadId, limit, resetAware })`
  - `persistAssistantTurn({ sender, text, threadId, modelUsed })`

- `src/lib/server/chat_prompt.ts`
  - One companion-aware system prompt builder.
  - Accepts capabilities, target workspace, thread, current tier, and run mode.

- `src/lib/server/chat_actions.ts`
  - `runStreamingReply`
  - `runImageGeneration`
  - `runWorkerDispatch`
  - `runHermesReply`
  - Each action consumes the normalized turn context instead of re-reading and re-classifying from scratch.

Target result:

- `src/routes/api/chat/+server.ts` becomes a dispatcher under roughly 200 LOC.
- `src/routes/api/chat/sdk-stream/+server.ts` becomes a stream adapter under roughly 250 LOC.
- Prompt changes and history slicing have exactly one implementation.

### 3. Provider/model routing exists in more than one place

Evidence:

- `src/routes/api/chat/sdk-stream/+server.ts:149` defines `Provider`.
- `src/routes/api/chat/sdk-stream/+server.ts:162` defines `TIER_MODELS`.
- The file comment says this mirrors `src/lib/server/llm_router.ts`.
- Companion-specific default model selection is embedded in route code at `src/routes/api/chat/sdk-stream/+server.ts:428`.
- Voice model selection is separate again in `src/routes/api/chat/voice-reply/+server.ts`.

Why it matters:

Model selection is product behavior. It should not be route plumbing. Today a future "make companion-v1 the default everywhere" change has to touch route code and may miss voice or the legacy route.

Proposal:

Create `src/lib/server/model_catalog.ts`:

- Define `Provider`, `Tier`, model IDs, display labels, auth requirements, and companion defaults.
- Export `resolveChatModel({ mode, providerOverride, tier, requestedModel })`.
- Export `resolveVoiceModel()`.
- Keep route adapters responsible only for turning the resolved model into the SDK/Ollama/CLI call.

Target result:

- One model catalog used by `llm_router`, `sdk-stream`, `voice-reply`, and `model-choices`.
- Tests can assert companion mode defaults to `COMPANION_DEFAULT_MODEL` without hitting HTTP.

### 4. Voice mode is good product work, but lifecycle is too tightly coupled to UI and systemd details

Evidence:

- Client voice controller starts services, opens mic, opens WebSocket, manages audio contexts, queues TTS, handles captions, and handles barge-in in `src/lib/chat/realtime-voice.svelte.ts:482`.
- Server endpoint shells out to `sudo -n /usr/bin/systemctl` directly in `src/routes/api/chat/voice-control/+server.ts:23`.
- Cold-start readiness, service names, STT port, and TTS health URL live in route code.

Why it matters:

Voice mode has the highest runtime risk. It spans iOS browser behavior, systemd, GPU services, WebSocket STT, local TTS, and model streaming. Keeping control logic directly inside route and UI files makes it harder to test the failure paths that matter: service start timeout, partial service readiness, barge-in aborts, background/foreground audio resume, and exit cleanup.

Proposal:

Create server-side voice service modules:

- `src/lib/server/voice_services.ts`
  - `getVoiceStatus()`
  - `startVoiceServices()`
  - `stopVoiceServices()`
  - Isolate systemd calls, unit names, readiness probing, and timeouts.

- `src/lib/server/voice_reply.ts`
  - Build recent voice history.
  - Normalize alternating user/assistant turns.
  - Stream plain text from Ollama.
  - Persist only complete successful turns, or explicitly mark aborted partials if partial persistence is desired.

On the client:

- Split `realtime-voice.svelte.ts` into:
  - `voice-session.svelte.ts` for UI state and high-level phase transitions.
  - `voice-audio.ts` for AudioContext, TTS queue, and playback.
  - `voice-stt.ts` for WebSocket and mic worklet.

Target result:

- Voice route unit tests can mock service state without invoking `sudo`.
- Client voice phases become testable as a state machine.

### 5. Companion mode still leaks Console vocabulary and kernel assumptions

Evidence:

- Prompt says "inside LogueOS Console" in `src/routes/api/chat/+server.ts:28` and `src/routes/api/chat/sdk-stream/+server.ts:265`.
- Default selected repo is `LogueOS-Console` in `src/routes/chat/+page.svelte:53`.
- Sidebar still renders "CORE: LogueOS-Console" in `src/lib/components/ThreadsSidebar.svelte:292`.
- Web push and completion poller still contain `/console` URLs in `src/lib/server/web_push.ts` and `src/lib/server/completion_poller.ts`.
- `src/lib/server/usage.ts`, `src/lib/server/shipments.ts`, and dispatch-related modules still read kernel-oriented artifacts even though the companion is supposed to be kernel-off safe.

Why it matters:

Some of this is harmless in wired mode, but it makes it hard for CC to know which behavior is intentionally companion-specific versus leftover clone residue. It also increases the chance of kernel calls creeping back into companion mode.

Proposal:

Add a "clone residue" sweep after the structural split:

- Introduce `appIdentity` in server/client config:
  - `appName`
  - `basePath`
  - `defaultWorkspace`
  - `conversationPersonaName`
  - `pushDefaultUrl`
- Replace hard-coded Console wording through that identity object.
- Move kernel-only modules into `src/lib/server/kernel/` or explicitly name them `kernel_*`.
- Add a test or script that fails on new `/console`, `LogueOS Console`, or kernel path strings outside approved compatibility files.

### 6. There is no dedicated test harness for the refactor targets

Evidence:

- `package.json` has `check`, `lint`, and `check:mobile-pwa`, but no unit or Playwright test script.
- `src/lib/server/config.ts` comments mention a boolean-matrix unit test, but I did not find one in the repo.

Why it matters:

The areas most likely to regress are behavior-heavy and cross-route. Svelte type checking will not catch mode gate regressions, duplicate persistence, wrong provider defaults, stale prompt wording, voice-service failure handling, or thread history slicing.

Proposal:

Add a small test stack before major extraction:

- Use `vitest` for pure server/client modules.
- Keep Playwright for one smoke path once the app is running.
- First test targets:
  - `runMode` matrix: wired, companion, empty/garbage mode.
  - `model_catalog` defaults: companion local default, explicit cloud override, local tier.
  - `chat_turn` persistence: operator row, assistant row, thread touch, reset-aware history.
  - `voice_services`: start/status/stop behavior with mocked `execFile`, port probe, and TTS health.
  - `chat_prompt`: companion wording does not identify itself as Console in companion mode.

## Proposed Work Plan

### Phase 0: Hygiene Baseline

Scope:

- Run Prettier once across the repo.
- Fix or record any ESLint errors exposed after formatting.
- Add `test` script and minimal Vitest setup.

Gate:

- `npm run check`
- `npm run lint`
- `npm test`

### Phase 1: Server Turn Service

Scope:

- Add `chat_turn.ts` and `chat_prompt.ts`.
- Move common persistence/classification/history/prompt logic out of both chat POST routes.
- Keep route behavior unchanged.

Gate:

- Unit tests for turn persistence and reset-aware history.
- Manual send in normal streaming chat still persists one operator row and one assistant row.

### Phase 2: Model Catalog

Scope:

- Add `model_catalog.ts`.
- Replace duplicated `Provider`/`TIER_MODELS`/companion-default logic.
- Keep route-specific SDK/Ollama/CLI adapters thin.

Gate:

- Unit tests for model resolution.
- Manual cloud model override still works.
- Companion mode default still resolves to `COMPANION_DEFAULT_MODEL`.

### Phase 3: Client Chat Controllers

Scope:

- Extract streaming controller, composer controller, thread controller, and slash registry from `+page.svelte`.
- Do not change markup in the same PR except for wiring.

Gate:

- `+page.svelte` below roughly 900 LOC.
- Streaming send, regenerate, paste-to-attachment, upload, thread switch, and slash commands still work.

### Phase 4: Voice Service Boundary

Scope:

- Move voice-control systemd logic into `voice_services.ts`.
- Move voice reply history/model logic into `voice_reply.ts`.
- Split client voice controller only after server-side voice logic has tests.

Gate:

- Mocked unit tests for voice start/status/stop.
- Manual enter/exit voice mode starts and stops the services.
- Barge-in still aborts reply and TTS.

### Phase 5: Companion Identity and Clone Residue Sweep

Scope:

- Add central app identity config.
- Replace Console wording and `/console` URLs where companion mode should not inherit them.
- Fence remaining kernel-only code into clearly named modules.

Gate:

- Search-based residue check.
- Prompt snapshot verifies companion identity.
- PWA URLs point to `/companion`.

## Specific Guardrails for CC

- Do not combine visual redesign with the structural refactor. Keep UI markup stable until controllers are extracted.
- Do not delete wired mode until the operator explicitly decides it is no longer needed; it is still useful as a parity harness.
- Do not relax the existing tool unlock gate. The `x-companion-tools-key` path in `sdk-stream` is sensitive and should remain explicit.
- Do not let voice service endpoints run arbitrary service names. Keep the unit allowlist hardcoded or config-validated.
- Preserve the fresh DB bootstrap behavior in `bootstrap.ts`; it is one of the cleanest pieces in the fork.

## Suggested First PR

Title:

`refactor: extract shared chat turn service`

Contents:

- Add `src/lib/server/chat_turn.ts`.
- Add `src/lib/server/chat_prompt.ts`.
- Move common persistence, classification, reset-aware history, and prompt building into those modules.
- Update `src/routes/api/chat/+server.ts` and `src/routes/api/chat/sdk-stream/+server.ts` to call the shared service.
- Add Vitest and tests for the new modules.

Why first:

It attacks the highest drift risk without touching the large Svelte component or the voice stack. It also creates reusable seams for the later streaming and voice refactors.

## Verification Performed

Commands run:

```bash
npm run check
npm run lint
```

Results:

- `npm run check`: passed with 0 errors and 0 warnings.
- `npm run lint`: failed during `prettier --check .`; 39 files need formatting. ESLint did not run because Prettier exited first.
