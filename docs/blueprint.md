# LogueOS-Companion — Build Blueprint

> Founding blueprint for extracting the Console chat surface into a standalone, local-model
> companion app (installable iPhone PWA over HTTPS). Produced 2026-05-28 from three parallel
> design passes: an 11-agent architecture workflow, a PWA/HTTPS design pass, and a 107-agent
> fact-checked deep-research pass (voice-mode focus). Move this into the companion repo as
> `docs/` / README when the repo is created.

---

## 1. Decision recap (operator)

- **Build:** clone first (prove it decoupled, behaves the same), then fork into the local companion.
- **Model:** `companion-v1` (verified installed as `companion-v1:latest`, 9 GB, fits the 16 GB RTX 5060 Ti).
- **Scope:** full — voice, image-gen, code canvas, threads, markdown, streaming.
- **Must be an installable PWA over HTTPS.**
- **Priority feature:** a voice mode with a live two-way transcript (your speech → text as you speak, model reply streaming as text) + an option to **disable the oncoming text** (voice-only).

---

## 2. Recommended architecture — "Copy-Boot-Strip + one mode flag"

Won the judge panel on both faithfulness (91) and operator-fit (88).

Build **one** standalone SvelteKit 5 (runes) + adapter-node app: **`LogueOS-Companion`**, port **18769**, base path **`/companion`**. It is a near-verbatim copy of the chat surface (which already renders chrome-free inside the Console). One server-side env flag, `LOGUEOS_APP_MODE`, selects the mode:

| Mode | DB / services | Behavior |
|---|---|---|
| **`wired`** (clone) | shared kernel DB + gateway | Identical to today's `/chat`. The **parity-proof** step. Throwaway — run by hand, not a permanent service. |
| **`companion`** (fork) | private `companion.db` + local Ollama | Default model `companion-v1`. All kernel-only features switched off. **Boots and runs with the LogueOS kernel completely OFF.** Full feature set kept. |

**Why this design:** copying code that already works cannot regress it (max faithfulness). The flag is parsed **once** in `config.ts` into named, greppable, unit-testable booleans (`kernelWired`, `dispatchEnabled`, `observationsEnabled`, `gatewayWorkspaces`, `completionPoller`, `killSwitchEnabled`). Decoupling is **additive guards, zero deletions** — the lowest-breakage, fully-reversible path. Default is `wired` (fail-closed: an unset/typo'd flag behaves as the safe clone, never silently points at an empty DB).

---

## 3. The bug the plan designs around

A fresh `companion.db` would **crash on the first message**: two tables (`chat_messages`, `chat_user_state`) are created by the *kernel*, not the chat code — `chat.ts` only reads/writes them. Fix: a new `bootstrap.ts` creates exactly those two tables (+ indexes) from the **authoritative live schema** pulled from the real DB (the research even caught and corrected a wrong schema guess — the real `chat_user_state` has `last_thread TEXT NOT NULL DEFAULT 'default'`). Called first + unconditionally in `hooks.server.ts`; idempotent, so safe in both modes.

---

## 4. What moves (file manifest)

- **Copy verbatim (~65 files):** `chat/+page.{svelte,server.ts}`, all 27 `api/chat/**` endpoints, the 6 chat components + `ToastContainer`, `$lib/chat/*` (incl. the just-extracted `voice.svelte.ts`), chat types, `toasts.ts`, all chat-relevant `$lib/server/*` (incl. `providers/*`, `claude_cli_stream.ts`, `chat.ts`), `app.html`, `app.css`, icons.
- **Adapt (~18 files):** `package.json` (rename), `svelte.config.js` (`/console`→`/companion` string ONLY — copy the dual-base block verbatim), `vite.config.ts` (port 18769, keep `allowedHosts:true`), `config.ts` (mode flag + Linux paths), `hooks.server.ts`, `+layout.svelte` (immersive-only, drop the 5-tab nav), the 5 kernel-coupled endpoints (guarded), `service-worker.ts` (4 `/console`→`/companion` spots), `model-choices.ts` (companion-v1 first), `manifest.webmanifest` (scope `/companion/`).
- **New:** `bootstrap.ts`, root `+page.svelte` (→ `/companion/chat`), `linux/systemd/logueos-companion.service`, `.env`, `README.md`.

---

## 5. Decoupling — 7 kernel chokepoints + 1 emitter (all gated, kernel-OFF safe)

1. **Completion poller** (`hooks.server.ts`) → `if(completionPoller)` + internal early-return.
2. **Worker dispatch** `@cc/@agy` (`api/chat`) → `if(dispatchEnabled)`; else friendly "dispatch is a kernel feature" system message.
3. **Workflow buttons** (`api/chat/workflow`) → guard + hidden client-side.
4. **Activity feed** (`api/chat/activity`) → returns empty.
5. **Approve** (`api/chat/approve`) → no-op.
6. **Workspace fetch** (`+page.server.ts`) → already falls back gracefully; short-circuit to skip the 3 s timeout.
7. **Kill-switch** (`+layout`) → dropped (lives in the chrome we remove).
8. **Observation emitters** → early-return when `!observationsEnabled` (keeps `companion.db` free of Tier-0 rows). A unit test asserts the full on/off matrix per mode, so no guard can be silently forgotten.

---

## 6. Database, env, deploy

- **DB:** wired = shared kernel DB (instant parity). companion = fresh private `~/dev/LogueOS-Companion/data/companion.db` + private uploads dir; self-initializes via `bootstrap.ts` + the existing lazy `CREATE TABLE IF NOT EXISTS` modules.
- **Env:** own `.env` (gitignored, mode 600). Secrets copied **by value from the canonical Orchestrator `.env`** — names only in any doc/log, never values. Keys: `OLLAMA_BASE_URL`, `COMPANION_DEFAULT_MODEL=companion-v1:latest`, + provider keys for full scope (Gemini, Claude OAuth, ElevenLabs, AssemblyAI).
- **Deploy:** `logueos-companion.service` systemd unit — `After=ollama.service` (NOT the gateway, so it boots kernel-off), own `EnvironmentFile`. Build `vite build` → `node build/index.js`.
- **HTTPS / PWA:** reuse the existing **Tailscale Funnel** (real `*.ts.net` TLS cert) — one command adds `/companion` alongside `/console`. Own manifest (`scope`/`start_url` `/companion/`, name "LogueOS Companion") so iOS installs it as a **separate** home-screen PWA. Service worker + iOS push hardenings (`event.waitUntil`) + safe-area handling all ported. **No app-level auth** — Tailscale is the boundary (the sealed iOS-PWA lesson). Verification gate: "installs as a PWA over HTTPS on the iPhone."

---

## 7. Voice mode design spec (fact-checked — the priority feature)

The research confirmed (against vendor docs) that **ChatGPT, Gemini Live, and Claude all converged on exactly the pattern you described**, so we're borrowing the proven shape:

- **In-thread, first-class input** (ChatGPT, Nov 2025 — they removed the separate voice screen): your **interim transcript renders live in/above the composer as you speak**, and the **assistant reply streams as live text in the thread**. Not a separate orb screen.
- **Captions ON/OFF toggle** = your "disable oncoming text" request, exactly. A `cc`-style button (ChatGPT's `cc`, Gemini's top-right captions button are the direct analogs). Default captions visible; toggle to **voice-only**. (Reply text still saved to history even when hidden, so it's there later.)
- **Barge-in** — interrupt by speaking; cancels in-flight TTS (Claude). Plus a **Push-to-Talk** fallback for noisy rooms / iOS.
- **Turn-taking** via Silero + WebRTC VAD.
- **Local pipeline (runs on the 16 GB GPU):** mic → WebSocket → local **RealtimeSTT** server (faster-whisper: `tiny.en` for instant interim partials + a larger model for the final) → **Ollama companion-v1** → local streaming **TTS (Piper/Kokoro)**. ElevenLabs streaming stays as an optional higher-quality cloud TTS.
- **iOS reality check (important):** do **NOT** use the browser Web Speech API for STT on iOS — it's unreliable and historically blocked in standalone PWAs. Stream mic audio to the local STT server over WebSocket instead. iOS suspends audio when backgrounded, so **true hands-free continuous listening may be foreground-only on iPhone**; push-to-talk is the robust fallback. This means the real-time voice mode needs a **small local STT/TTS service** (more than today's turn-based talkback) — it's the price of the live-transcript experience you want.

**Refuted (don't build on these):** Claude does *not* reliably write your live speech into the input field; the iOS Web Speech API does *not* reliably stream on-device interim results.

---

## 8. Flagship feature gap analysis — STATUS: partial

The research pass spent its verification budget on the **voice mode** (your priority) and verified it thoroughly. The **broad feature gap analysis** (persistent memory, Projects, Artifacts/Canvas, web search + citations, vision upload, conversation branching/edit-resend, reasoning display, model-picker UX, prompt suggestions, PWA polish across all 10 apps) was **requested but not adversarially verified in this batch** — it's flagged as not-yet-researched. We still have the earlier captured borrows (Artifacts panel, Projects-light, auto-attach long pastes, pin threads, select-and-ask). **Recommendation:** run a second verified research pass dedicated to the broad gap analysis (offered as a decision below).

---

## 9. Phased execution (each phase has a hard verification gate)

- **Phase 0 — Scaffold:** empty app boots at `/companion` on 18769. Gate: `curl` → 200, build clean.
- **Phase 1 — CLONE:** copy chat surface, wire to shared kernel, `LOGUEOS_APP_MODE=wired`. Gate: chat-surface-harness E2E shows identical behavior to Console `/chat` (streaming, model switch, `@cc` actually dispatches, voice, image, canvas) — zero console errors.
- **Phase 2 — FORK:** add the mode flag + booleans + `bootstrap.ts` + 8 guards, `LOGUEOS_APP_MODE=companion`. Gate: **stop the entire kernel**, boot companion, send a message → streams from companion-v1, threads persist on a fresh DB, full scope intact, `@cc` shows the friendly message, no `ECONNREFUSED` in the journal, boolean-matrix test passes.
- **Phase 2.5 — Voice mode (new build):** stand up the local RealtimeSTT + TTS service; wire in-thread live transcript + captions toggle + barge-in/PTT. Gate: live two-way transcript on desktop + iPhone; measure mouth-to-ear latency on the 5060 Ti.
- **Phase 3 — Deploy + expose:** systemd unit, Funnel `/companion`, install on the iPhone as its own PWA, restart-durable, kernel-off durable. Gate: browser-load QA evidence before declaring done.

---

## 10. Risk register (top items)

| Risk | Sev | Mitigation |
|---|---|---|
| Fresh DB missing 2 kernel tables → crash on first message | HIGH | `bootstrap.ts` with authoritative live schema, called first; Phase 2 tests it |
| companion-v1 may handle tool-calls / long output worse than cloud | MED | Phase 2 verifies; gate tools to a simpler set in companion mode if needed; cloud models stay selectable |
| Forgotten guard re-introduces a kernel call that hangs kernel-off | MED | named booleans + boolean-matrix unit test + Phase 2 boots with kernel STOPPED, watches journal |
| iOS PWA scope collision with Console | MED | distinct manifest `scope`/`start_url`/name; Phase 3 verifies separate install |
| Base-path dual-strip / Vite `allowedHosts` footguns | MED | copy `svelte.config`/`vite.config` verbatim, change only the path string |
| iOS voice: AudioContext suspends backgrounded; Web Speech API unreliable | MED | server-side STT over WebSocket; push-to-talk fallback; resume AudioContext on foreground |

---

## 11. Open decisions for the operator

1. Repo name/location — `LogueOS-Companion` @ `~/dev/LogueOS-Companion` (GitHub private). Port `18769`.
2. Fork DB content — fresh empty vs one-time copy of current threads.
3. Voice build timing — full real-time local voice now (incl. the local STT/TTS service) vs ship the app first and add it next.
4. Cloud voice vs local voice for v1; web push on/off; Tailscale public-Funnel vs tailnet-only.
5. Run the dedicated **broad gap-analysis** research pass (verified) now or later.

> Operator decisions (2026-05-28): **clone-then-fork**; model **companion-v1**; **full** scope (voice+image); **fresh empty** DB; **public Funnel**; voice mode **built now**; gap research **run** (results below).

---

## 12. Feature-gap roadmap (fact-checked 2026-05-28, 111-agent verified pass)

Post-v1 feature borrows, severity-ranked. All findings high-confidence (3-0 unanimous, primary vendor + self-hosted-reference-app sources). These inform the roadmap AFTER the clone→fork→voice build lands — not blockers for it.

**HIGH — build next:**
- **Persistent cross-conversation memory + user profile.** Every flagship ships explicit-saved + inferred + custom-instructions memory; self-hostable on Ollama (LibreChat/Open WebUI). Ship a user-editable memory store (Settings → Personalization) + account-wide custom instructions, layered above per-workspace context. Local caveat: autonomous "what to save" is unreliable on small models → default to manual + passive injection, optional auto-save.
- **Collapsible reasoning / thinking panel.** Parse Ollama reasoning models' `<think>…</think>` (or `message.thinking`) into a collapsed CoT panel above the answer with an elapsed timer. Fully local.
- **Web search + inline citations.** Self-hostable via SearXNG + `[n]` citations + `#`+URL fetch-to-context + RAG over uploads. Rerankers (Jina/Cohere) are cloud; SearXNG path is fully local.

**MED — borrow opportunistically:**
- Conversation **sharing** via read-only snapshot URL + outbound `navigator.share` (the iOS-PWA-safe share path).
- **Account-wide custom instructions / user profile** → 3-tier stack: global profile › project instructions › per-conversation.
- **Project-scoped instructions** (extends planned Projects-light).
- **Branching / edit-and-resend / regenerate-variants** — ship with clear affordances + undo (LibreChat fork UX is reportedly accident-prone).
- **Canvas → HTML/SVG/Mermaid + sandboxed React** (point Sandpack at a local bundler to avoid CDN telemetry).

**HIGH — DO NOT build (negative finding):** iOS share-TARGET (appearing in the iPhone share sheet) — `share_target` is unimplemented in WebKit/iOS (WebKit #194593 still NEW). Use outbound Web Share + snapshot URL instead.

**Open (follow-up pass):** keyboard shortcuts / command palette, starter & follow-up prompt chips, local export (MD/JSON/PDF) vs share, iOS app-shortcuts/offline polish, and an **empirical bench of memory + reasoning-render quality on companion-v1** before committing to auto-save defaults.
