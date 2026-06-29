# Sully Flagship Hybrid Canon — Visual + Motion + Interaction

**Status:** Operator-approved direction (2026-06-11) · **Not shipped yet**  
**Purpose:** Single source of truth for the real implementation pass — merges the best of **CUR** and **AGY** mockup packs and defines how Sully should **flow, animate, and feel** like a flagship iOS chat app (PWA + Capacitor WebView).

**Mockup references:**

| Pack | Port | Folder |
|------|------|--------|
| CUR | 8765 | `docs/flagship-visual-mockups/` |
| AGY | 8766 | `docs/flagship-visual-mockups/agy/` |
| Side-by-side shots | — | `docs/audit-shots/2026-06-11-cur-vs-agy-mockups/` |

**Related canon:** `docs/design/sully-locked-spec.md` · `docs/2026-06-11-flagship-visual-pass-plan.md` · skills: `companion-ui-design`, `mobile-chat-ux`, `ios-pwa-safe-area`, `ios-pwa-input-hygiene`, `companion-deploy-verify`

**Implementation worktree (when ready):** `/home/dreighto/dev/worktrees/LogueOS-Companion/cur` · branch `feat/cur-flagship-visual-pass`

---

## Part 1 — Hybrid visual picks (screen by screen)

Use this table when implementing. **Do not pick one pack wholesale** — hybrid is intentional.

| Screen | Take from | Specific choices |
|--------|-----------|------------------|
| **Compare / north star** | CUR | Keep `05-compare-before-after.html` as the stakeholder “10-second pitch” page |
| **Quiet thread (01)** | **Hybrid** | AGY: flat assistant text, glass user bubble, icon-only focused actions, mono timestamps · CUR: explicit “focused” demo copy so operators understand progressive disclosure |
| **Empty state (02)** | **AGY** | Vertical full-width starter chips; Fraunces greeting; breathing orb · Wire chip tap → pre-fill composer + focus (already in voice via `submitPrompt`; mirror for text) |
| **Sidebar (03)** | **AGY** | Chronological groups, Active Tasks section, settings chip · No `HOST:` footer · Unified glass popover recipe |
| **Message sheet (04)** | **AGY** | Native iOS list sheet (Copy / Regenerate / Read aloud / feedback) · Reuse **RunSheet** motion tokens (`--ease-sheet`, transform-only) |
| **Worker in thread (06)** | **Tie** | Both preserve WorkerPill; keep collapsed-by-default · AGY styling on pill chrome |
| **Voice mode (07)** | **AGY + CUR 08** | AGY: kinetic orb, phase rings, italic live transcript, segmented states · CUR `08-voice-gemini-inspired.html`: bottom **waveform dock** (mute + keyboard exit), minimal top chrome, captions optional |
| **Header / composer** | **Both** | Model chip in **header** (not inside composer pill) · Composer = attach + input + talkback + send/voice FAB only |
| **PWA update banner** | AGY spec | Demote to bottom toast/badge — don’t steal header tap targets |

### Visual non-negotiables (locked spec)

- Indigo palette only — magenta retired (`sully-locked-spec.md`)
- Blend Mk II: Fraunces (display), Bricolage (body), JetBrains Mono (metadata only)
- Ash discipline: `--accent` / `--live` only when something is **live** (streaming, listening, running worker)

---

## Part 2 — What “flagship iOS” means for Sully

Flagship feel is **not** more animations everywhere. It is:

1. **Quiet by default** — chrome and controls appear only when needed  
2. **Predictable motion** — same easing family, same durations, same sheet language  
3. **Physical feedback** — buttons compress on press; sheets drag; orb breathes when live  
4. **Never fight the platform** — safe areas, keyboard, scroll, 60fps on WebKit  
5. **One continuous flow** — chat ↔ voice ↔ run sheet ↔ sidebar feel like one app, not four plugins  

ChatGPT / Claude / Gemini converge on these mechanics. Sully adds **dispatch/work** without breaking the calm surface.

---

## Part 3 — Motion system (use locked tokens only)

All motion MUST use tokens from `app.css` / `sully-locked-spec.md`:

| Token | Use |
|-------|-----|
| `--ease-standard` | Hover, color, small UI |
| `--ease-emphasized` | Enter transitions, chip press |
| `--ease-enter` | Message/card appear |
| `--ease-exit` | Dismiss, fade out |
| `--ease-spring` | Orb, worker breath, playful micro-bounce (sparingly) |
| `--ease-sheet` | **Sheets only** — sidebar drawer, message action sheet, model picker, RunSheet |
| `--dur-fast` (120ms) | Press feedback, icon toggles |
| `--dur-med` (180ms) | Chip/button state |
| `--dur-base` (220ms) | Popover open |
| `--dur-panel` (360ms) | Full sheets, sidebar slide |
| `--dur-long` (480ms) | Voice caption fade, ambient glow |

### Hard performance rules (from locked spec)

1. **Large surfaces animate `transform` + `opacity` only** — never animate `height`, `margin`, or `box-shadow` on full-width panels  
2. **`.sully-smooth` on small controls only** — not on sheets or message list containers  
3. **`prefers-reduced-motion: reduce`** — every new animation gets a reduced branch (see `RunSheet.svelte`, `WorkerPill.svelte`)  
4. **Ambient gradients on `.app-bg` fixed layer** — not on `body` (Capacitor scroll repaint)  
5. **Compositor hints:** `will-change: transform` only during active animation; remove after  

---

## Part 4 — Interaction flows (screen-by-screen)

### A. App shell & navigation

| Interaction | Target behavior | Reference in repo |
|-------------|-----------------|-------------------|
| Sidebar open/close | Slide from left, `--ease-sheet`, ~360ms; scrim fade | `ThreadsSidebar.svelte` (fix desktop first-load bug per June audit) |
| Thread switch | Cross-fade feed OR short slide; scroll to bottom on enter | `+page.svelte` thread change handler |
| Model picker | Bottom sheet on mobile, popover on desktop; same glass recipe | `ChatHeader.svelte` |
| Settings entry | Sidebar footer profile chip → `/settings` | AGY 03 + existing settings route |

**Flagship cue:** Sidebar and model sheet must share **one** glass border/blur/radius recipe (June audit H2).

---

### B. Chat feed (`MessageFeed.svelte`)

| Interaction | Target behavior |
|-------------|-----------------|
| First paint | Jump to bottom (`scrollBehavior: 'auto'`) after `requestAnimationFrame` |
| New message while at bottom | Smooth pin to bottom |
| New message while reading history | **Do not** yank; show “N new ↓” pill |
| User sends | Always pin to bottom |
| Message appear | Subtle enter: opacity + 8px translateY, `--ease-enter`, ~220ms |
| Long-press / tap focus | Glass highlight ring; icon action row fades in (`opacity` only) |
| Long-press (mobile) | Open AGY-style action **sheet** (not inline row) |

**Flagship cue:** Copy/Regen/Play hidden until focus — matches AGY 01 + CUR focused demo.

---

### C. Composer (`Composer.svelte`)

| Interaction | Target behavior |
|-------------|-----------------|
| `+` attach reveal | Keep existing staggered `fly` — best micro-interaction in app |
| Send press | `btn-tactile-brand` active scale + optional haptic (Phase D) |
| Sending state | Border/shadow pulse on **pill only** — children stay opaque (existing `composerSendingGlow`) |
| Empty starter chip tap | Pre-fill textarea + focus; optional 80ms chip scale feedback |
| Talkback / voice FAB | Mutual exclusion via `voice-mode.svelte.ts` — never two mics |

**Flagship cue:** Composer stays visually stable; state communicates through **glow**, not layout jumps.

---

### D. Worker / dispatch (`WorkerPill` + `RunSheet`)

| Interaction | Target behavior |
|-------------|-----------------|
| Pill lands in thread | `wpill-enter` scale fade (existing) |
| Running | Breath animation on status dot / Lottie (existing `pillModel`) |
| Tap pill | RunSheet slides up — **reuse `rs-sheet-in/out` keyframes** |
| Verify badges | Collapsed on pill; full proof in RunSheet expand |

**Flagship cue:** Worker noise stays in the pill/sheet — never floods message text.

---

### E. Voice mode (`VoiceMode.svelte`) — hybrid AGY + CUR 08

| Phase | Visual | Motion |
|-------|--------|--------|
| **Enter** | Full-screen overlay; ambient indigo wash | Scrim fade 220ms; orb scale from 0.92 → 1 |
| **Idle** | Large orb (Sully avatar inside or behind orb ring) | Slow breath 3.2s loop |
| **Listening** | Ripple rings + “streaming input” micro-label | Ring pulse 1.4s; live transcript fades in |
| **Thinking** | Orb → thinking avatar state | Cross-fade sprite, no layout shift |
| **Speaking** | Caption optional; waveform dock animates | Bar CSS animation or amplitude-driven later |
| **Exit** | Keyboard/dock button or X | Reverse enter; resume composer with 180ms fade |

**Bottom dock (from CUR 08):** Glass pill with `[keyboard]` · animated bars · `[mute]` — replace center 80px mic FAB for hands-free default.

**Flagship cue:** Voice feels like **Gemini Live** (atmospheric, orb-centric), not a settings panel with a giant button.

---

## Part 5 — Implementation phases (real pass)

Ship in this order. Each phase ends with **iPhone PWA verification** (`companion-deploy-verify` + `iphone-webkit` Playwright).

### Phase A — Quiet conversation (visual only)

| PR | Files | Motion |
|----|-------|--------|
| A1 Message quiet | `MessageFeed.svelte` | Message enter; action fade-in on focus |
| A2 User glass bubbles | `MessageFeed.svelte`, `app.css` | None on bubble — border/color only |
| A3 Progressive actions | `MessageFeed.svelte` + new sheet component | Sheet: copy `RunSheet` pattern |
| A4 Sidebar scrub | `ThreadsSidebar.svelte` | Existing slide; unify popover glass |

**Exit criteria:** Compare mockup parity on phone; no always-on action row.

---

### Phase B — Structure & empty state (visual + tiny client logic)

| PR | Files | Motion |
|----|-------|--------|
| B1 Model chip → header | `ChatHeader.svelte`, `Composer.svelte` | Chip transition 180ms |
| B2 Empty starters | `MessageFeed.svelte` or `+page.svelte` | Chip press scale; composer focus |
| B3 PWA banner demote | `PwaUpdatePrompt.svelte` | Slide from bottom, non-blocking |

**Exit criteria:** Mockup 02 parity; composer interior simplified.

---

### Phase C — Voice flagship surface (visual + existing controller)

| PR | Files | Motion |
|----|-------|--------|
| C1 Voice layout hybrid | `VoiceMode.svelte`, `app.css` | Orb breath, phase rings, dock pill |
| C2 Captions drawer | `VoiceMode.svelte` | Sheet for transcript history |
| C3 Waveform dock | `VoiceMode.svelte` | CSS bars idle/listening/speaking |

**Exit criteria:** Mockup AGY 07 + CUR 08 listening state on real iPhone mic.

---

### Phase D — Active work awareness (needs backend/stream)

| PR | Files | Motion |
|----|-------|--------|
| D1 Active Tasks sidebar | `ThreadsSidebar.svelte`, dispatch stream | Row enter/stale fade |
| D2 Approval inline | New `ApprovalBanner.svelte` or extend RunSheet | Banner slide-down 220ms |
| D3 Haptics (Capacitor) | Thin wrapper + call sites | `ImpactLight` on send, sheet dismiss, voice enter |

**Exit criteria:** Operator sees running workers without thread-hopping; haptics on TestFlight build.

---

## Part 6 — Technical checklist (engineers)

### New shared primitives to extract (avoid one-off CSS)

| Primitive | Purpose | Base on |
|-----------|---------|---------|
| `SullySheet.svelte` | Message actions, model picker mobile | `RunSheet.svelte` scrim + keyframes |
| `SullyGlassPopover.svelte` | Header/sidebar popovers | Locked `--glass-bg`, `--glass-border` |
| `SullyMessageActions.svelte` | Focus + long-press → sheet | AGY 04 IA |
| `StarterChips.svelte` | Empty state + voice idle | AGY 02 vertical layout |
| `VoiceOrbStage.svelte` | Phase-reactive orb + rings | AGY 07 + `SullyAvatar` |
| `VoiceWaveDock.svelte` | Bottom mute/keyboard/bars | CUR 08 |

### Svelte 5 motion patterns

```svelte
<!-- Message enter (prefer CSS class over inline transition for list perf) -->
<div class="msg-enter">...</div>

<!-- Sheet (transform only) -->
<div class="sheet" style:transform={open ? 'translate3d(0,0,0)' : 'translate3d(0,100%,0)'}>

<!-- Focus actions (opacity only — no layout reflow) -->
<div class="msg-actions" class:visible={focused}></div>
```

Use `svelte/transition` (`fly`, `fade`) for **mount/unmount** of small nodes (composer chips). Use **CSS keyframes** for looping orb/waveform.

### Verification matrix (every phase)

| Check | Tool |
|-------|------|
| Desktop layout | Playwright `chromium` |
| iPhone viewport | Playwright `iphone-webkit` |
| Real phone | Tailscale PWA + operator spot-check |
| Safe area | Header/composer/voice dock padding |
| Keyboard | Composer stays visible on focus (16px input rule) |
| Reduced motion | iOS Settings → Reduce Motion |
| Performance | No jank during sheet drag + feed scroll |

**Caveat:** Linux WebKit ≠ iOS Safari for URL bar / input zoom — **real iPhone is final word**.

---

## Part 7 — What we explicitly defer

Same as June audit + AGY spec Part C:

- Separate `/spaces` page  
- Per-action browser permission spam  
- Poe-style bot grid home  
- Light mode theme  
- Real-time mic-driven waveform (v1 uses CSS bars; v2 optional Web Audio analyser)  

---

## Part 8 — Worker assignment (when implementation starts)

| Layer | Owner | Scope |
|-------|-------|-------|
| **Visual + motion + Svelte** | CUR | Phases A–C; new primitives; mockup parity |
| **Backend / stream / approval** | CC | Phase D hooks; `autonomous_dispatch`, sidebar task feed |
| **Capacitor haptics / TestFlight** | CC + `ship-ios` skill | Phase D haptics on native shell |
| **Spec updates** | CH / operator | This doc becomes canon after dreighto sign-off |

---

## Quick reference — phone URLs

```text
CUR mockups:  http://room.taila28611.ts.net:8765/
AGY mockups:  http://room.taila28611.ts.net:8766/
Production:   http://room.taila28611.ts.net:18769/companion/chat
Hybrid canon: docs/2026-06-11-flagship-hybrid-canon.md  (this file)
```

---

*Generated by CUR after side-by-side mockup review. Update this doc when operator picks final voice direction or Phase A ships.*
