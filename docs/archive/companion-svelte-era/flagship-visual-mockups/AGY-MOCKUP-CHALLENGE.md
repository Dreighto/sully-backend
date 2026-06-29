# AGY Mockup Challenge — Sully Flagship Visual Pass

**Purpose:** Side-by-side comparison of frontend visual capability between **CUR** (Cursor) and **AGY** (Antigravity). Same information architecture and mockup pages — **your own taste and craft** within Sully's locked palette and typography.

**Operator:** dreighto · **Date:** 2026-06-11  
**CUR reference (do not edit):** `docs/flagship-visual-mockups/` (HTML + `shared.css` + screenshots)  
**Your output folder:** `docs/flagship-visual-mockups/agy/` (create this — parallel structure)

**View CUR baseline on phone:** `http://room.taila28611.ts.net:8765/05-compare-before-after.html`

---

## What you're being asked to do

Build an **interactive HTML mockup pack** that covers the **same screens and UX stories** as CUR's pack, but with **your** layout rhythm, hierarchy, micro-interactions, and visual personality.

You are **not** cloning CUR's CSS. You are **not** implementing Svelte production code. This is a **static HTML + CSS prototype** exercise only.

### Hard constraints (non-negotiable)

1. **Palette — Indigo only.** Use the canonical tokens from `docs/design/sully-locked-spec.md` Section 2. **Magenta is retired.** Do not introduce new brand hues outside the locked semantic set (`--green`, `--amber`, `--red`, `--blue` for status only).

2. **Typography — Blend Mk II only.**
   - Display: `Fraunces Variable` (headings, greeting hero lines)
   - Body: `Bricolage Grotesque Variable` (UI chrome, bubbles, chips)
   - Mono: `JetBrains Mono Variable` (only if you need code/technical labels)
   - You may use Google Fonts `@import` in mockups only (production uses self-hosted Fontsource — not your problem here).

3. **Ash discipline.** `--accent` / `--live` for things that are **actually live** (streaming, listening, primary CTA, active run). Quiet chrome stays `--ui` / `--t3` / `--t4`. Don't paint the whole UI indigo.

4. **iPhone frame.** Present each screen in a **393×852** phone stage with safe-area insets (`env(safe-area-inset-top/bottom)`). Mockups are reviewed on the operator's iPhone via Tailscale.

5. **Scope.** HTML + CSS (+ minimal vanilla JS only if a tab switcher or sheet toggle helps). **No** React/Vue/Svelte build step, **no** backend, **no** edits to `src/**`.

6. **Preserve Sully differentiators** (content must appear on the relevant screens):
   - Worker/dispatch pill in active thread
   - Voice mode FAB + immersive voice overlay
   - Flat assistant replies (not heavy card chrome on every Sully message)
   - Thinking / tool-use states (can be simplified in static HTML)

### Creative freedom (your taste)

- Spacing, density, border radius choices (within token scale if you use `--r-sm/md/lg/xl/pill`)
- Glass vs solid surfaces, shadow depth, gradient placement
- Chip shapes, header composition, sidebar grouping
- Motion hints (CSS transitions, hover/active states)
- How "premium" vs "minimal" the empty state feels
- Compare page layout (side-by-side, slider, or your own comparison device)
- Voice mode mood (calm studio vs energetic live session — your call)

---

## Required deliverables

Create **all** files under `docs/flagship-visual-mockups/agy/`:

| File | Must communicate (content IA) |
|------|-------------------------------|
| `index.html` | Hub linking to every mockup; one-line description of your visual direction |
| `shared.css` | **Your** shared styles; must define the locked `:root` tokens (copy from spec) |
| `01-chat-quiet.html` | Active thread: quiet message surface, glass/neutral user bubble, flat Sully reply, **no** always-on action row; model control in header not buried in composer |
| `02-empty-state.html` | Greeting + **tappable suggested prompt chips** (at least 4); composer at bottom |
| `03-sidebar-clean.html` | Thread list with human-readable titles; Active Tasks section; **no** dev footer (`HOST:`, raw IP) |
| `04-message-sheet.html` | Long-press / overflow **action sheet** (Copy, Regenerate, Read aloud, etc.) — native iOS sheet feel |
| `05-compare-before-after.html` | Side-by-side or equivalent: **today's noisy chrome** vs **your target** (can use simplified "before" column) |
| `06-chat-with-worker.html` | Thread with **WorkerPill** + in-progress work; assistant replies stay visually quiet |
| `07-voice-mode.html` | Full-screen voice overlay: orb/avatar focal point, status line, mic control, idle starters optional; show at least idle + one active state (listening or speaking) |

**Optional but appreciated:**

- `README.md` in `agy/` — how to view, your design rationale (3–8 bullets)
- `screenshots/` — PNG captures at 393×852 for each page

---

## Reference material (read before you start)

| Resource | Why |
|----------|-----|
| `docs/design/sully-locked-spec.md` | Canonical tokens, ash discipline, motion |
| `docs/flagship-visual-mockups/*.html` | CUR's IA — **structure reference, not style reference** |
| `docs/2026-06-11-flagship-visual-pass-plan.md` | Phase goals + what "flagship" means for Sully |
| `docs/2026-06-01-companion-audit-findings.md` | Gap list vs ChatGPT/Gemini/Claude |
| `docs/flagship-visual-mockups/screenshots/baseline/` | Production Sully + Gemini reference PNGs |

---

## Acceptance checklist (operator will use this)

- [ ] All 8 HTML pages + `index.html` + `shared.css` exist under `agy/`
- [ ] Palette matches locked Indigo tokens (no magenta, no random purple/pink brand)
- [ ] Typography uses Fraunces + Bricolage (Blend Mk II)
- [ ] Each page reads clearly at iPhone width without horizontal scroll
- [ ] Safe-area padding on top/bottom chrome
- [ ] `05-compare` makes the before/after story obvious in &lt;10 seconds
- [ ] Voice + WorkerPill differentiators visible on the right screens
- [ ] No edits outside `docs/flagship-visual-mockups/agy/` (and optional screenshots)

---

## How to view when done

### Persistent service (survives reboot — recommended)

```bash
sudo cp /home/dreighto/dev/LogueOS-Companion/linux/systemd/logueos-companion-mockups-agy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now logueos-companion-mockups-agy.service
systemctl is-active logueos-companion-mockups-agy.service   # expect: active
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8766/   # expect: 200
```

Stop when done reviewing:

```bash
sudo systemctl stop logueos-companion-mockups-agy.service
```

### Ad-hoc (no systemd)

```bash
cd /home/dreighto/dev/LogueOS-Companion/docs/flagship-visual-mockups/agy
python3 -m http.server 8766 --bind 0.0.0.0
```

| URL | |
|-----|--|
| Loopback | `http://127.0.0.1:8766/` |
| Tailscale (phone) | `http://room.taila28611.ts.net:8766/` |

Compare against CUR: `http://room.taila28611.ts.net:8765/`

---

## Copy-paste prompt for AGY

Give AGY this block verbatim (or point it at this file):

```text
You are AGY, the frontend visual worker. This is a MOCKUP-ONLY exercise — no production Svelte code.

TASK: Build a parallel HTML mockup pack for LogueOS-Companion (Sully) under:
  /home/dreighto/dev/LogueOS-Companion/docs/flagship-visual-mockups/agy/

Read the full brief first:
  /home/dreighto/dev/LogueOS-Companion/docs/flagship-visual-mockups/AGY-MOCKUP-CHALLENGE.md

Also read:
  /home/dreighto/dev/LogueOS-Companion/docs/design/sully-locked-spec.md

REFERENCE (information architecture only — do NOT copy CUR's visual style):
  /home/dreighto/dev/LogueOS-Companion/docs/flagship-visual-mockups/

DELIVERABLES:
  agy/index.html
  agy/shared.css
  agy/01-chat-quiet.html
  agy/02-empty-state.html
  agy/03-sidebar-clean.html
  agy/04-message-sheet.html
  agy/05-compare-before-after.html
  agy/06-chat-with-worker.html
  agy/07-voice-mode.html
  agy/README.md (short rationale)

RULES:
  - Use YOUR layout, spacing, and visual taste — make it feel flagship-iOS premium.
  - LOCKED: Indigo palette + Blend Mk II typography from sully-locked-spec.md (no magenta).
  - LOCKED: Same UX stories as CUR mockups (quiet thread, empty chips, clean sidebar, action sheet, worker pill, voice overlay, before/after compare).
  - iPhone 393×852 presentation with safe-area insets.
  - Static HTML/CSS only; vanilla JS only for trivial tab/sheet toggles.
  - Do not edit src/** or any file outside docs/flagship-visual-mockups/agy/

WHEN DONE:
  - List files created.
  - 3–5 bullets on your design choices vs CUR.
  - Confirm Tailscale view command: python3 -m http.server 8766 --bind 0.0.0.0 from agy/
```

---

## After both packs exist

| Worker | Folder | Default port |
|--------|--------|--------------|
| CUR | `docs/flagship-visual-mockups/` | 8765 (systemd `logueos-companion-mockups.service`) |
| AGY | `docs/flagship-visual-mockups/agy/` | 8766 (`logueos-companion-mockups-agy.service`) |

Operator compares the same screens across ports on the iPhone, then picks direction (or hybrid) before CUR implements in the `feat/cur-flagship-visual-pass` worktree.

---

*This doc is the handoff artifact. CUR generated it; AGY executes from the prompt block above.*
