# AGY Brief — Flagship UX Teardown & Implementation Spec (Test Run)

**Purpose:** Test-run AGY's research + spec-writing capability before the real implementation pass. This is **documentation only** — no code, no mockups, no PR.

**Operator:** dreighto · **Date:** 2026-06-11  
**App:** LogueOS-Companion (Sully) — SvelteKit + Vercel AI SDK 6  
**Output file (AGY writes here):** `docs/2026-06-11-agy-flagship-ux-teardown.md`

**Not this task:** Visual HTML mockups → see `docs/flagship-visual-mockups/AGY-MOCKUP-CHALLENGE.md` (separate test, port 8766).

---

## What you're being asked to do

Perform a **legal product teardown** of modern AI assistant apps (ChatGPT, Claude, Gemini and peers), studying **only public/visible UX patterns**, then translate findings into **original Sully/LogueOS recommendations** — not copies of branding, icons, or proprietary identity.

Deliver a spec an engineer (CUR or CC) could implement in phased PRs.

---

## Legal / ethics guardrails (non-negotiable)

- Do **not** access private APIs, hidden prompts, protected assets, internal code, or non-public behavior.
- Analyze **public interface behavior** and widely documented UX patterns only.
- Do **not** copy competitor branding, icons, names, or proprietary visual identity.
- Convert findings into **original** Sully patterns scoped to our locked Indigo design system.

---

## Read before writing (repo context)

Load in order:

1. `AGENTS.md` (repo root)
2. `docs/2026-06-01-companion-audit-findings.md` — prior deep audit; **synthesize and update**, do not ignore or rewrite from zero
3. `docs/design/sully-locked-spec.md` — Indigo palette, Blend Mk II typography, ash discipline (magenta retired)
4. `docs/2026-06-11-flagship-visual-pass-plan.md` — current visual direction
5. Skim existing implementation (read-only):
   - `src/routes/chat/+page.svelte` — layout orchestration ("ChatShell" equivalent)
   - `src/lib/components/MessageFeed.svelte`
   - `src/lib/components/Composer.svelte`
   - `src/lib/components/ChatHeader.svelte`
   - `src/lib/components/ThreadsSidebar.svelte`
   - `src/lib/work-surface/pill/WorkerPill.svelte`
   - `src/lib/work-surface/pill/RunSheet.svelte`
   - `src/lib/work-surface/pill/pillModel.ts` — dispatch/run states
   - `src/lib/chat/voice-mode.svelte.ts` — voice surface states
   - `src/routes/api/chat/sdk-stream/+server.ts` — `streamText` path
   - `src/routes/api/chat/voice-reply/+server.ts` — voice plain-text stream (separate from SDK UI stream)
   - `src/lib/server/companion_tools.ts`
   - `src/lib/server/chat/stream_prepare.ts`
   - `src/lib/server/chat/autonomous_dispatch.ts`

Optional reference screenshots: `docs/flagship-visual-mockups/screenshots/baseline/`

---

## Hard output rules

| Rule                         | Detail                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------- |
| **Output only**              | Write **one** file: `docs/2026-06-11-agy-flagship-ux-teardown.md`                |
| **No code**                  | Do not edit `src/**`, `package.json`, configs, or mockup HTML                    |
| **No hype**                  | Every section needs actionable recommendations with file paths                   |
| **Preserve differentiators** | Do not recommend removing WorkerPill, voice mode, talkback, or dispatch surfaces |
| **Design locked**            | No new brand colors outside `sully-locked-spec.md`                               |

---

## Required deliverables (inside the output doc)

### Part A — Plain-English spec (operator-readable)

Write for dreighto first. No jargon walls. Answer: _what should Sully feel like, and what changes first?_

Cover:

1. **Feature inventory** (competitor patterns → Sully gap/opportunity):
   - chat composer
   - message stream
   - sidebar / history
   - attachments
   - artifacts / files
   - tool-use indicators
   - model / mode picker
   - mobile / PWA behavior
   - error / retry states
   - approval / confirmation states
   - **voice mode / talkback** (immersive + in-composer)
   - **active work / dispatch** (WorkerPill, run sheet)
   - **push / PWA update / standalone** behavior

2. **State machine** (UX-level, reconciled with Sully):
   - idle
   - user composing
   - message submitted
   - model streaming
   - tool running
   - worker dispatched
   - waiting on user
   - verifying
   - complete
   - failed
   - canceled

   For **each state**, label: `EXISTS` | `EXTEND` | `NEW` and point to the Sully source of truth (e.g. `pillModel.ts`, `voice-mode.svelte.ts`, composer modes, SDK stream status).

3. **Sully-specific improvements** (your original ask):
   - show what Sully is doing **now**
   - show what happens **next** / what Sully is **waiting on**
   - keep worker details **collapsed by default**
   - expose proof / verification **only when expanded**
   - support artifact download + creator metadata
   - support **multiple workers on one task** without flooding chat

4. **What the June audit got right vs stale** — explicit callouts.

### Part B — Technical implementation checklist

Engineer-facing. Include:

1. **SvelteKit component map** — use these target names, but **map each to existing files** where they exist:

   | Target concept      | Likely existing file                      |
   | ------------------- | ----------------------------------------- |
   | ChatShell           | `src/routes/chat/+page.svelte`            |
   | MessageList         | `MessageFeed.svelte`                      |
   | Composer            | `Composer.svelte`                         |
   | AttachmentTray      | staged attachments in `Composer.svelte`   |
   | WorkCard            | `DispatchCard.svelte`, hybrid cards       |
   | WorkerPill          | `WorkerPill.svelte`                       |
   | Run sheet           | `RunSheet.svelte`                         |
   | ArtifactShelf       | `WorkSurfaceDock.svelte`, hybrid surfaces |
   | ToolEventTimeline   | (may be NEW — propose placement)          |
   | ApprovalBanner      | (may be NEW or extend pill badges)        |
   | VerificationSummary | extend `pillModel.ts` gate badges         |

   Label each: `EXISTS` | `RENAME` | `NEW`. If renaming, include migration notes.

2. **Vercel AI SDK mapping** — grounded in real routes:
   - where `streamText` should be used (already: `sdk-stream/+server.ts`)
   - where tool calling should live (`companion_tools.ts`)
   - where agent-loop behavior should live
   - where human-approval interrupts should surface in UI
   - how streamed tool/task events should appear in the message stream
   - **Note:** voice turns use `voice-reply` plain-text stream today — not `streamText` UI stream

3. **Phased PR slices** — small reviewable chunks (e.g. Phase 1 quiet message surface, Phase 2 run awareness, Phase 3 artifact shelf). Tag each slice: visual-only vs needs backend.

### Part C — Explicitly deferred / do-not-build-yet

List items that are out of scope for the first implementation wave (separate pages for projects, full agent marketplace, etc.). Reference `2026-06-01-companion-audit-findings.md` rejections where applicable.

---

## Anti-patterns (reject in your own output)

- Marketing fluff without file-level actions ("world-class", "stunning", "masterpiece")
- Greenfield architecture that ignores `WorkerPill`, `RunSheet`, `sdk-stream`
- Recommending removal of voice mode, talkback, or dispatch as "simplification"
- Introducing magenta or off-palette brand colors
- Implementing code or HTML mockups (that's a different brief)

---

## Acceptance checklist (operator will use)

- [ ] Single output file at `docs/2026-06-11-agy-flagship-ux-teardown.md`
- [ ] Part A readable without opening the repo
- [ ] Part B references real file paths (not invented module tree)
- [ ] State machine labels EXISTS / EXTEND / NEW per state
- [ ] Component map labels EXISTS / RENAME / NEW per component
- [ ] SDK section distinguishes chat `sdk-stream` vs voice `voice-reply`
- [ ] Sully differentiators preserved and strengthened (not flattened to generic chat)
- [ ] June audit synthesized — not duplicated verbatim
- [ ] Part C clearly bounds first implementation wave
- [ ] Zero edits outside the one output markdown file

---

## Copy-paste prompt for AGY

Give AGY this block verbatim (or point it at this file):

```text
You are AGY. This is a TEST-RUN spec exercise — documentation only, no code.

Read the full brief:
  /home/dreighto/dev/LogueOS-Companion/docs/2026-06-11-agy-flagship-ux-teardown-brief.md

TASK:
  Perform a legal product teardown of public UX patterns in modern AI assistant apps
  (ChatGPT, Claude, Gemini). Translate into original Sully/LogueOS recommendations.

OUTPUT (only):
  /home/dreighto/dev/LogueOS-Companion/docs/2026-06-11-agy-flagship-ux-teardown.md

STRUCTURE:
  Part A — Plain-English spec (operator-readable)
  Part B — Technical implementation checklist (file-oriented, phased PR slices)
  Part C — Deferred / do-not-build-yet

RULES:
  - Public/visible UX only. No private APIs, no reverse engineering.
  - No competitor branding copies. Indigo + Blend Mk II typography locked.
  - Map components and states to EXISTING Sully files where they exist.
  - Label every state/component: EXISTS | EXTEND | NEW (or RENAME for components).
  - Ground Vercel AI SDK advice in sdk-stream, companion_tools, stream_prepare,
    autonomous_dispatch. Note voice-reply is a separate path.
  - Synthesize docs/2026-06-01-companion-audit-findings.md — don't ignore it.
  - Preserve WorkerPill, voice mode, talkback, dispatch surfaces.
  - Do NOT edit src/** or create HTML mockups.

WHEN DONE:
  - Confirm output path.
  - 5 bullets: your highest-impact recommendations.
  - 3 bullets: where you disagreed with or updated the June audit.
  - 1 bullet: biggest risk if we implement your spec blindly.
```

---

## How this relates to other work

| Artifact                                          | Owner              | Purpose                                                         |
| ------------------------------------------------- | ------------------ | --------------------------------------------------------------- |
| `2026-06-01-companion-audit-findings.md`          | CC/CUR prior audit | Evidence base — AGY updates                                     |
| `2026-06-11-flagship-visual-pass-plan.md`         | CUR visual pass    | Look/feel implementation (later)                                |
| `flagship-visual-mockups/AGY-MOCKUP-CHALLENGE.md` | AGY visual test    | HTML mockups on port 8766                                       |
| **This brief**                                    | AGY spec test      | Architecture/UX spec markdown only                              |
| `feat/cur-flagship-visual-pass` worktree          | CUR                | Production visual implementation (after in-flight tickets land) |

**Recommended order for operator testing:**

1. Send AGY **this brief** (spec) OR mockup challenge (visual) — **one at a time**, not both in one session unless you say which is priority.
2. Review output quality before assigning real implementation.

---

_CUR generated this brief for operator testing. Not canon until dreighto approves the output._
