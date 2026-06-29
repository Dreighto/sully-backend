# Sully Flagship Visual Pass — Implementation Plan

> **Operator decision (2026-06-11):** dreighto has assigned **CUR (Cursor)** as the dedicated **frontend visual worker** for this pass. Scope is **look-and-feel only** — CSS, Svelte markup, motion, layout, component styling. No backend routes, no dispatch/voice logic changes, no schema migrations unless a visual feature is blocked without a trivial read-only API tweak (escalate first).
>
> **Execution model:** Work in an **isolated git worktree** so the operator can compare side-by-side against production `main` without disturbing in-flight kernel/companion tickets. Merge only after iPhone viewport screenshots pass and Playwright smoke is green.
>
> **Timing:** Start **after** current in-flight companion changes land (LOS-193 run sheet, LOS-205 worker labels, primitives stage 3+). This plan is prep work — do not race active branches.

**Goal:** Raise LogueOS-Companion (Sully) from “power-user dev tool” polish to **flagship iOS chat-app feel** — quiet conversation surface, one glass design language, consumer-grade sidebar, native interaction patterns — while preserving Sully’s active-work identity (dispatch pills, voice stack).

**Architecture:** Phased visual-only PRs on branch `feat/cur-flagship-visual-pass`, each scoped to 1–3 components, verified with `companion-deploy-verify` (build → restart → iPhone Playwright screenshots). Reuse locked Indigo tokens + in-flight `SullyButton` / `SullyPill` / `SullyCard` primitives (LOS-204); extend leaf-site migration rather than inventing parallel styling.

**Canon to load before any edit:**

1. `docs/design/sully-locked-spec.md` — Indigo tokens, ash discipline, motion
2. `docs/2026-06-01-companion-audit-findings.md` — gap list + flagship patterns (still mostly valid)
3. Skill: `companion-ui-design` — calm/premium, NOT Console density
4. Skills: `ios-pwa-safe-area`, `ios-pwa-input-hygiene`, `mobile-chat-ux`, `svelte-5-runes-disciplinarian`
5. Verify with: `companion-deploy-verify` after every UI-touching PR

**Competitive reference pack:** `docs/audit-shots/2026-06-11-flagship-visual-pass/` (baseline Sully + Gemini; ChatGPT/Claude capture notes below)

---

## Worktree setup (CUR)

**Reserved worktree (created 2026-06-11):**

| Item | Value |
|------|-------|
| Branch | `feat/cur-flagship-visual-pass` |
| Path | `/home/dreighto/dev/worktrees/LogueOS-Companion/cur` |
| Base | `main` @ `4cc7391` (post LOS-204 stage-2 primitives) |

**Operator compare loop:**

```bash
# Production baseline (main hub — do not edit for visual experiments)
open http://127.0.0.1:18769/companion/chat

# CUR worktree — build + run on alternate port OR swap service temporarily
cd /home/dreighto/dev/worktrees/LogueOS-Companion/cur
npm run build
# Option A: temporary port via env (if wired) — check companion service unit
# Option B: operator stops prod service, points unit at worktree build, restarts, screenshots, restores
```

**Before starting implementation**, rebase worktree onto latest `main`:

```bash
cd /home/dreighto/dev/worktrees/LogueOS-Companion/cur
git fetch origin
git rebase origin/main
```

**Do not touch:** `captain/*` branches, `agents/cc/LogueOS-Companion`, `w1`/`w3` active ticket worktrees, `.mcp.json`, `card_catalog.db`.

---

## Competitive research (2026-06-11)

### Captured screenshots

| App | File | Notes |
|-----|------|-------|
| **Sully (baseline)** | `sully-baseline/companion-empty-iphone.png` | Chat with history — action row always visible, dev PWA banner |
| **Sully (baseline)** | `sully-baseline/companion-sidebar-iphone.png` | Sidebar — dev footer `HOST: 127.0.0.1`, technical thread slugs |
| **Sully (baseline)** | `sully-baseline/companion-model-sheet-iphone.png` | Model picker sheet — strong; keep pattern |
| **Gemini (logged-out)** | `reference/ref-gemini-mobile.png` | Suggested prompt chips, minimal header, mode chip in composer, light theme |

### Blocked captures (headless Playwright)

ChatGPT (`chatgpt.com`) and Claude (`claude.ai`) returned **Cloudflare “Just a moment…”** in the Linux headless session. **Before Phase A implementation**, capture logged-in mobile screenshots on the operator’s iPhone or a authenticated desktop session:

- ChatGPT iOS / `chatgpt.com` — empty state, active thread, long-press message menu, sidebar drawer
- Claude iOS / `claude.ai` — same surfaces
- Drop PNGs into `docs/audit-shots/2026-06-11-flagship-visual-pass/reference/` with names `ref-chatgpt-*.png`, `ref-claude-*.png`

### Flagship patterns to borrow (research + live Gemini)

| Pattern | ChatGPT | Claude | Gemini | Sully today | Action |
|---------|---------|--------|--------|-------------|--------|
| Conversation-first layout | ✓ | ✓ | ✓ | ✓ | Keep |
| Flat assistant text (no card) | ✓ | ✓ | ✓ | ✓ | Keep |
| User message subtle tint / indent | ✓ | ✓ | ✓ | Heavy zinc bubble | **Phase A** — glass or plain |
| Message actions hidden until focus | ✓ | ✓ | partial | Always-on labeled row | **Phase A** — overflow / long-press |
| Model picker in header or chip above input | ✓ | ✓ | ✓ in composer | Inside composer pill | **Phase B** — relocate |
| Suggested prompts on empty state | ✓ | ✓ | ✓ chips | Greeting only | **Phase B** |
| Sidebar: human titles, no dev chrome | ✓ | ✓ | ✓ | Slugs + HOST footer | **Phase A** |
| Hide empty threads until first send | ✓ | ✓ | ✓ | Shows immediately | **Phase A** |
| One popover/sheet glass recipe | ✓ | ✓ | ✓ | Mixed (thread menu ≠ model sheet) | **Phase B** |
| 44pt touch targets on chrome | ✓ | ✓ | ✓ | Partial (footer has sm: shrink) | **Phase A** — keep 44px mobile |
| Haptics on send / sheet dismiss | native | native | native | none | **Phase C** (Capacitor) |

### Sully differentiators to **keep** (not clone away)

- Full-screen Voice Mode + Talkback (ahead of Claude mobile)
- WorkerPill in-feed for dispatch runs
- Tool-call chips + thinking monster avatar
- Active-work identity — hop-in-and-go, not “pick a GPT first”

---

## Gap summary (priority order)

### P0 — “Quiet the conversation” (highest visual ROI)

1. **Message action row** — `MessageFeed.svelte` always shows Copy · Regen · Play · 👍 · 👎. Collapse to icon-only; show on message focus, long-press sheet, or `···` overflow (Claude mobile pattern).
2. **User bubble material** — `border-zinc-700/60 bg-zinc-900/60` reads Slack-era; composer uses glass. Unify to `border-white/[0.08] bg-white/[0.04] backdrop-blur` or right-aligned plain text.
3. **Sidebar dev chrome** — remove `CORE: … · HOST: …` footer (`ThreadsSidebar.svelte`). Replace with settings/profile chip or hide entirely in prod builds.
4. **Destructive sidebar toolbar** — tuck `CLEAR ALL` into settings overflow; demote `SHOW ARCHIVED` to sidebar kebab.
5. **Technical thread slugs in list** — hide threads with `message_count === 0` until first send; ensure auto-title runs (already wired — verify UI respects it).

### P1 — “One design language” (primitives continuation)

6. **Finish LOS-204 leaf migration** — sidebar rows, thread kebab popover, activity pill, PWA update prompt → `SullyPill` / `SullyButton` / `SullyCard`.
7. **Unify popover chrome** — one recipe everywhere: `border-white/[0.08] bg-[#0e0e11]/85 backdrop-blur-2xl shadow-[var(--shadow-float)]`.
8. **Kill `border-zinc-*` in chat surface** — per June audit; use `--line` / `--line2` tokens only.
9. **Radius discipline** — collapse to 4 values: 8 / 12 / 16 / full (see audit §3 radius zoo).
10. **Relocate model chip** — out of composer pill interior → header `Auto ▾` or single chip *above* pill (ChatGPT/Claude pattern). Composer keeps: `+` · textarea · talkback · send/voice.
11. **Header lightness** — drop `border-b` at rest; transparent blur header over feed; workspace-context icon → sidebar settings (optional).
12. **Empty-state suggested prompts** — 3–4 tappable chips under greeting (Gemini borrow): e.g. “What’s running?”, “Summarize today”, “New thread”.

### P2 — “Native iOS polish” (after Capacitor path stable)

13. **Haptics** — `@capacitor/haptics` on send, voice-mode enter, thread switch, sheet dismiss.
14. **Keyboard** — `@capacitor/keyboard` resize; confirm composer stays above home indicator.
15. **PWA update prompt** — badge/dot instead of top banner blocking chrome.
16. **Long-press message menu** — native-feel sheet with Copy / Regen / Speak / Feedback.
17. **Active Tasks sidebar block** — persistent dispatch awareness (feeds LOS-192/193; visual shell only in this pass if sheet API not ready — use placeholder section with correct styling).

### Explicitly out of scope for CUR visual pass

- Backend streaming, dispatch, voice bridge, tier routing
- LOS-192 run sheet **logic** (can style sheet when API lands)
- Light mode theme
- Desktop sidebar invisible-on-load bug — **one-line fix**; include if touching sidebar anyway (`ThreadsSidebar.svelte` transform vs `lg:translate-x-0`)

---

## File map (primary touch targets)

| Phase | Files |
|-------|-------|
| A | `src/lib/components/MessageFeed.svelte`, `src/lib/components/ThreadsSidebar.svelte`, `src/lib/components/PwaUpdatePrompt.svelte` |
| B | `src/lib/components/Composer.svelte`, `src/lib/components/ChatHeader.svelte`, `src/app.css`, `src/lib/components/sully/*`, `src/routes/chat/+page.svelte` (layout only) |
| C | Capacitor wrapper + thin Svelte haptic helpers (coordinate with `ship-ios` skill owner) |

---

## Phased tasks (checkbox tracking)

### Phase A — Quiet the conversation

- [ ] **A1 Message actions — progressive disclosure**
  - Add `messageFocusedId` or long-press handler on assistant rows
  - Default: timestamp only; focused/long-press: icon row or bottom sheet
  - Preserve `data-testid` hooks for e2e (`feedback-up`, etc.) — may need `force-visible` test attr
  - Mobile: keep `min-h-[44px]` on revealed actions
  - Verify: screenshot thread with 3+ messages; actions not visible until interaction

- [ ] **A2 User bubble glass**
  - Replace zinc opaque bubble with glass material matching composer
  - Max-width / right-align unchanged
  - Verify: user + assistant messages in one screenshot; materials feel related

- [ ] **A3 Sidebar consumer cleanup**
  - Remove dev footer (`CORE` / `HOST`)
  - Move `CLEAR ALL` behind confirm + settings overflow
  - Hide threads with zero messages from list (unless pinned/The Den)
  - Unify thread kebab popover to glass recipe (quick win toward B)
  - Verify: sidebar screenshot has no hostname text

- [ ] **A4 PWA update prompt demotion**
  - Replace full-width top banner with unobtrusive chip/badge (or dismiss-to-tray)
  - Ensure z-index does not block header taps (2026-06-11 Playwright click intercept)

- [ ] **A5 Phase A verification gate**
  - `npm run build` in worktree
  - Playwright iPhone 393×852: chat, sidebar, model sheet
  - `npx playwright test --project=iphone-webkit` for chat smoke (if selectors changed, update minimally)
  - 0 console errors on `/companion/chat`

### Phase B — One design language

- [ ] **B1 Primitives leaf batch (audit table from LOS-204)**
  - Migrate: thread row actions, counters, sidebar header buttons, activity pill
  - Declare `surfaces:` in commit messages per companion dispatch convention

- [ ] **B2 Model chip relocation**
  - Move picker trigger to `ChatHeader.svelte` (or chip row above composer)
  - Composer pill = attachments + text + voice/send only
  - Sheet/dropdown behavior unchanged (portal + swipe dismiss)

- [ ] **B3 Empty-state suggested prompts**
  - Static chip set first (no LLM); wire to `textDraft` + focus composer
  - Match Gemini chip rhythm: rounded-full, subtle border, horizontal scroll on narrow screens

- [ ] **B4 Header + feed atmosphere**
  - Header: remove border-b, increase transparency
  - Optional: soften radial atmosphere in `+page.svelte` — more subtle, less purple competing with Indigo

- [ ] **B5 Token sweep**
  - Ripgrep `border-zinc` in `src/lib/components` + `src/routes/chat` → replace with `--line*`
  - Radius zoo collapse per audit

- [ ] **B6 Phase B verification gate**
  - Same as A5 + compare screenshot set against `sully-baseline/` folder

### Phase C — Native iOS polish (separate PR(s) after A+B merge)

- [ ] **C1 Haptic wrapper** — light impact on send, medium on sheet dismiss
- [ ] **C2 Long-press message sheet** — consolidate actions into one native-style sheet
- [ ] **C3 Active Tasks sidebar section** — styled list; wire to real dispatch state when LOS-193 lands
- [ ] **C4 Device verify** — real iPhone 16 Pro over Tailscale; Eruda `?debug=1` if needed

---

## Verification checklist (every PR)

```bash
cd /home/dreighto/dev/worktrees/LogueOS-Companion/cur
npm run build
sudo -n systemctl restart logueos-companion.service   # only when operator approves service swap
# Playwright MCP: 393×852 → /companion/chat → fullPage screenshot → read PNG
# browser_console_messages level=error → 0 unexpected
```

**Done means:**

- [ ] iPhone viewport screenshots attached to PR or `docs/audit-shots/<date>/`
- [ ] No new `border-zinc-*` introduced in chat surface
- [ ] Locked tokens only (`sully-locked-spec.md`) — no raw hex in components
- [ ] `iphone-webkit` project green (or documented selector updates)
- [ ] Operator side-by-side compare against main hub approved

---

## PR strategy

| PR | Branch | Scope |
|----|--------|-------|
| PR1 | `feat/cur-flagship-visual-pass` | Phase A only (~4 files) |
| PR2 | same branch stacked or continuation | Phase B primitives + model relocation |
| PR3 | follow-up branch | Phase C native polish |

Title prefix: `feat(sully-ui):` · Reference this plan path in PR body.

**Merge policy:** Operator merge (CUR does not self-merge to main). CC VP Ops review for visual regressions + e2e.

---

## Handoff prompt (paste to CUR / other agent)

```text
You are CUR, the operator-assigned frontend VISUAL worker for LogueOS-Companion.

Read and execute:
  docs/superpowers/plans/2026-06-11-flagship-visual-pass-plan.md

Worktree (mandatory):
  /home/dreighto/dev/worktrees/LogueOS-Companion/cur
  branch: feat/cur-flagship-visual-pass

Rules:
  - Visuals only. No backend/dispatch/voice logic.
  - Follow docs/design/sully-locked-spec.md (Indigo, ash discipline).
  - Load skills: companion-ui-design, ios-pwa-safe-area, companion-deploy-verify.
  - Start with Phase A after rebasing onto latest origin/main.
  - Capture before/after iPhone screenshots in docs/audit-shots/.

Competitive refs:
  docs/audit-shots/2026-06-11-flagship-visual-pass/

Blocked: capture ChatGPT + Claude logged-in mobile screenshots into reference/ before Phase A if possible.
```

---

## References

- Prior audit: `docs/2026-06-01-companion-audit-findings.md`
- Design spec (historical D7): `docs/superpowers/specs/2026-05-30-sully-companion-rebuild-design.md`
- Locked tokens: `docs/design/sully-locked-spec.md`
- Primitives ticket context: LOS-204 (stage 2 shipped), stage 3+ queued
- Lane file: `LogueOS-Orchestrator/.logueos/context/current_lane.md`

**Author:** CUR (Cursor) · **Date:** 2026-06-11 · **Status:** Ready for execution after in-flight tickets land
