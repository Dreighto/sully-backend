# Sully Companion — Rebuild Design

**Date:** 2026-05-30
**Status:** Approved (brainstorm) — pending operator spec review → implementation plan
**Author:** CC (Claude Code) with Captain (dreighto)

---

## 1. Context & drivers

"Sully" is the operator's local companion — a warm conversational partner that lives on his hardware, and (long-term) the "in-between" hub that coordinates the LogueOS team and runs peer reviews.

The current app (`LogueOS-Companion`) is a fork of `LogueOS-Console`. A four-way audit (2026-05-30) found the bones are good (the controller extraction, `chat_turn`/`model_catalog` work) but it carries significant **Console fork debt** — a 1,200-line chat god-component, ~9 dead modules, dead routes, and the magenta brand hardcoded in ~30 places. Three things now make a clean-slate rebuild the right move:

1. **Fork debt** — polishing the inherited frontend means polishing the wrong foundation.
2. **Apple Developer Program** — the operator just joined, unlocking proper iOS mic/push/install permissions (the long-standing PWA pain).
3. **New tooling** — Capacitor path, Supabase, frontend-design skill.

## 2. Locked decisions

| #   | Decision        | Choice                                                                       | Rationale                                                                                                                                                                                                   |
| --- | --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Foundation**  | Native iPhone shell (Capacitor) around the web app                           | Real mic, native push, home-screen install — fixes the permissions pain — without a Swift rewrite. One web codebase.                                                                                        |
| D2  | **Scope**       | Rebuild the frontend clean; **keep the proven backend**                      | Sully's value (voice, brain, tools, memory) works; the debt is the inherited frontend. Low-regret, fast.                                                                                                    |
| D3  | **Hub role**    | Partner-first now; **architect for the hub later**                           | Ships the rebuild faster. Her brain-trust tools (consult/deep-think) are the v1 seed; full team-coordination is a later focused project.                                                                    |
| D4  | **Data/cloud**  | **Local-first** now; Supabase fallback later                                 | Matches her "lives on your hardware" identity. Supabase enters later for availability (keep her up when the machine is off).                                                                                |
| D5  | **Apprentice**  | One shadow model that learns Sully and **graduates into the cloud fallback** | Hermes principle (observe → shadow → graduate). The thing that keeps her up is the thing learning to _be_ her. Seam now, build later.                                                                       |
| D6  | **Navigation**  | **Chat-first + slide-in drawer**                                             | The conversation is the screen; ☰ = history, ⚙️ = settings, voice = full-screen takeover. Matches ChatGPT/Claude/Gemini; right for a chat companion.                                                       |
| D7  | **Look & feel** | **Clean & premium** (magenta brand, restrained)                              | Flat replies under a small magenta name-tag (no card); generous whitespace; accent reserved for identity (glossy orb + name dot) and the send button; subtle ambient magenta glow. Calm, modern, ages well. |

## 3. Architecture

Layered, local-first, with two named seams for later.

```
┌─────────────────────────────────────────────┐
│ 🩷 iPhone app shell (Capacitor)  [NEW]        │  real mic · native push · install
├─────────────────────────────────────────────┤
│ 🟠 Web frontend — fresh SvelteKit [REBUILD]   │  clean components · 1 design system
├──────────────────  HTTPS / Tailscale  ────────┤
│ 🟢🟠 App server [KEEP logic, TIDY structure]   │  chat streaming · routing · tools · push
├─────────────────────────────────────────────┤
│ 🟢 Brain (qwen3+persona) · Voice (STT/TTS) ·   │  [KEEP]
│    Memory (threads, SQLite)                    │
└─────────────────────────────────────────────┘

Designed-for-later seams (interfaces built in v1, implementations later):
  🔭 Apprentice → Fallback : shadow model consumes Tier-0 observations Sully
      already emits → shadow-drafts → graduates → becomes Supabase cloud fallback.
  🤝 Team hub : Sully dispatches/coordinates CC·GMI·AGY, runs peer reviews.
```

**Why these seams matter now:** v1 builds the _interfaces_ (a clean observation-emit path; a provider/brain seam that already supports multiple providers) so the apprentice and hub slot in without another rewrite.

## 4. Scope

### In v1

- Native iPhone app (Capacitor shell) with **proper mic permission, native push (APNs), home-screen install**.
- Fresh chat-first frontend: Chat (home) + slide-in History drawer + full-screen Voice mode + Settings.
- Carry-over backend, unchanged in behavior: qwen3 brain + persona + tools, STT/TTS voice, threads/conversation memory, multi-provider routing, web-search/machine-read/brain-trust tools.
- The audit cleanup as part of the rebuild: component decomposition, **tokenized magenta design system**, shared `IconButton`/`Popover` utilities, keyboard `focus-visible`, fix the lime-green markdown-link bug.

### Out of v1 (designed-for-later seams)

- The apprentice/observer model and its graduation ladder.
- The Supabase cloud fallback / off-machine availability.
- The full team-hub coordination + peer-review dispatch wiring.

### Explicitly dropped (fork debt — per audit)

- The `/chat/preview` scaffolding route, the ~9 dead Console modules, dead worker-dispatch/activity-poller/kill-switch code, dead header props. (Unless reclaimed by the hub seam — flagged in the audit; v1 leaves coordination machinery untouched, doesn't carry it into the fresh frontend.)

## 5. Frontend structure

**Surfaces:** Chat (home) · History (drawer) · Voice mode (full-screen) · Settings (model/voice picker, "edit Sully's context", permissions/push).

**Navigation:** chat-first. Header = ☰ (drawer) · Sully identity (orb + name) · ⚙️/model chip. Voice is a full-screen takeover, not a tab.

**Component breakdown** (kills the 1,200-line god-component):

- `MessageFeed` / `MessageBubble` (the conversation render — the surface we iterate on)
- `Composer` (textarea + attachments + voice/dictation triggers + send)
- `ChatHeader` (Sully identity + model picker + drawer toggle)
- `VoiceMode` (immersive full-screen)
- `ThreadsDrawer`, `SettingsSheet`
- Keep the working `.svelte.ts` state-controller pattern (threads, composer, streaming, voice); finish extracting tier/model + workspace-context controllers so the page stays small.

**Design system (one source of truth):**

- Magenta brand as real tokens (`--color-brand` #ec2d78, `-bright` #ff4d94, `-deep` #c4186a, `-soft` #ff7eb3, `-glow` #ff8fc0) → Tailwind `bg-brand`/`text-brand-soft` utilities, not literal hex.
- A `.sully-orb` class for the glossy thought-drop gradient; `.icon-btn` (44px mobile / 36px desktop tap target); `.popover-panel`; `.btn-brand` gradient.
- Global `:focus-visible` ring on `--color-ring`.
- **Functional mode colors stay** (amber=recording, emerald=talkback, cyan=image, purple=sending) — only the _identity_ is magenta.

**Look & feel (D7 — Clean & premium):** Sully's replies render as flat text under a small `● Sully` magenta name-tag (no bubble card). User messages in a subtle neutral pill. Generous vertical rhythm. Near-black background with a faint magenta ambient glow. Magenta reserved for: the orb, the name dot, the send button, and active/selected states.

## 6. Data flow

`iPhone shell → web frontend → app server (streaming endpoint) → provider/brain (local qwen3 default; cloud providers on override) → tokens stream back`. Voice: frontend ↔ local STT (WS) and TTS (HTTP), server-to-server. Memory: server reads/writes threads + messages to local SQLite. The frontend rebuild changes _none_ of these contracts — it re-consumes the same endpoints, which de-risks the rebuild.

## 7. iOS / Capacitor specifics

**Toolchain (confirmed 2026-05-30):** Node 22 / npm 11 present; nothing Capacitor/iOS installed yet (clean slate). Capacitor **8.x** set to add: `@capacitor/core`·`/cli`·`/ios` (8.3.4), plus plugins `push-notifications` `haptics` `keyboard` `status-bar` `splash-screen` `preferences` `app` `share` (8.x — all must track the same major). `keyboard` is load-bearing for the chat composer.

**Build & distribution machine (RESOLVED): cloud-CI, no Mac, no hardware.**

- The dev box is **Linux** — `@capacitor/core`/`cli`/plugins + the whole web build install and run here fine. `@capacitor/ios` (`pod install` → Xcode build → sign → TestFlight) **cannot** run on Linux.
- Decision: the iOS compile/sign/ship step runs on a **cloud macOS CI runner**. Linux stays Sully's home (server, model, voice, web dev); CI does only the native wrap + TestFlight push via **fastlane**.
- Recommended runner: **Codemagic** (generous free tier, first-class Capacitor support, handles signing + TestFlight with minimal config) — or **GitHub Actions `macos` runner** if we'd rather keep it in the existing GitHub flow (more manual fastlane/signing setup). Final pick in the plan.
- Apple Developer Program (operator enrolled) supplies the signing identity / App ID / TestFlight; the CI runner is the missing build machine.

**Per-capability:**

- **Mic:** native `getUserMedia`/Capacitor permission → fixes the PWA mic pain; voice mode gets reliable capture.
- **Push:** APNs via `@capacitor/push-notifications`; the existing web-push/dispatcher concept adapts to native device tokens. (iOS Web Push gotchas no longer apply once native.)
- **Backend reach:** the app talks to the local server over Tailscale (same boundary as today). The shell is a thin native wrapper; the server stays on the ROOM machine.

## 8. Error handling

- Frontend: classify stream errors (rate-limit / outage / auth / offline) into actionable messages — carry over the existing SDK error-classifier; show a clear "Sully's offline (your machine may be asleep)" state (the future cloud fallback's hook).
- Backend: keep the existing read-swallow policy for DB reads but make corrupt-DB distinguishable from empty (audit finding). Standardize a `jsonError()` envelope.

## 9. Testing

- Component tests for `MessageFeed`/`Composer` render + states.
- Keep the mobile-PWA check script; add an iOS-shell smoke (mic permission prompt, push registration).
- A live end-to-end turn (operator device) before declaring done — per the "browser-load QA before done" rule.

## 10. Risks & open questions

- **Capacitor + SvelteKit adapter:** the app server is SvelteKit (adapter-node). The Capacitor shell loads the web app — confirm whether it loads the _remote_ server URL (simplest; server-rendered) or bundles a static client that calls the API. **Recommended:** shell points at the Tailscale server URL (keeps SSR + one deploy). To confirm in planning.
- **Push:** native APNs key setup + the dispatcher adaptation is net-new plumbing.
- **Voice over native:** confirm the local STT WS / TTS HTTP are reachable from the native shell over Tailscale exactly as from the PWA.
- **Repo:** rebuild in the existing `LogueOS-Companion` repo (fresh `src/`, keep server libs) vs. a new repo. Recommend in-place to reuse the kept backend; decide in planning.

## 11. Migration approach

Keep `src/lib/server/**`, the voice services (`companion-speech`), the model, and the SQLite data. Rebuild `src/routes` + `src/lib/components` + `src/lib/chat` (controllers) + `src/app.css` clean. Add the Capacitor project. Delete the fork-debt modules per the audit. The kept server endpoints are the stable contract the new frontend consumes.
