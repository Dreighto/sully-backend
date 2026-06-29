# Flagship Polish Punch-List (living doc)

> **Purpose:** every craft-level polish item found during the flagship pass, captured against the
> right surface/phase so the **final polish pass** is one clean handoff — nothing re-found, nothing
> slipped. Updated each phase review. NOT for correctness bugs (those get fixed in-phase); this is the
> "works but not flagship yet" layer.
>
> **Sources:** CC review (in-hand testing + measurement), the operator (on-device feel), and an
> independent GPT review (2026-06-12, code-read). Items marked ✅-verified were confirmed in the live
> code, not just asserted.
>
> **Owner:** the motion/visual owner (CUR) executes; CC re-verifies by feel + instrumentation.
> **2026-06-12.**

---

## How to use this

- Each item: **surface · what's off · the fix · phase · source · status.**
- "Phase" maps to the hybrid canon. Most visual items fold into **B5 (token sweep)** or the **final
  polish pass**; motion items are governed by the **motion-engine doc** (`2026-06-12-motion-engine-…`).
- Status: `OPEN` / `IN A PR` / `DONE`.

---

## A. Sidebar — "chat history drawer, not a database browser" (GPT P0)

| #   | What's off                                                                                               | Fix                                                                                                                   | Phase      | Source | Status |
| --- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | ------ |
| A1  | ✅ `coreLabel` footer still renders (`ThreadsSidebar.svelte:471`, `text-zinc-500`) — dev chrome          | Remove, or replace with a Settings/Profile row                                                                        | B / polish | GPT+CC | OPEN   |
| A2  | ✅ `Show archived` + `Clear all` toolbar always visible (`:285–305`) — maintenance controls foregrounded | Move behind a `···`/Settings overflow; `Clear all` needs a confirm                                                    | B          | GPT    | OPEN   |
| A3  | ✅ Thread rows lead with a `Hash` icon + counter badge — dev-ish                                         | Human-first rows: title + date-group; drop hash; metadata tiny/optional                                               | B / polish | GPT+CC | OPEN   |
| A4  | ✅ ~30 `zinc-*` usages in the sidebar — off the locked Indigo ramp                                       | Sweep `border/bg/text-zinc-*` → `--line*` / `--t*` / `--ui` tokens                                                    | B5         | GPT+CC | OPEN   |
| A5  | Sidebar grouping is flat                                                                                 | Add chronological groups (Active / Today / Yesterday) + an **Active Tasks** block (visual shell; wire data later, CC) | B/D        | GPT    | OPEN   |
| A6  | Hide zero-message threads until first send                                                               | Filter empty threads from the list (canon A3)                                                                         | B          | canon  | OPEN   |

## B. Chat surface — calm conversation

| #   | What's off                                                                                                 | Fix                                                                     | Phase  | Source | Status                            |
| --- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ | ------ | --------------------------------- |
| B1  | ✅ Message body text mismatched: **user 14px vs assistant 16px** (spec wants 15px `--text-base`)           | One size on `--text-base`, consistent line-height                       | polish | CC     | OPEN (queued into Phase B prompt) |
| B2  | Timestamps read as **orphaned** — detached in the whitespace, alternating sides, break the vertical rhythm | Tuck tight to the message, quiet to `--t4`, or hide until message focus | polish | CC     | OPEN                              |
| B3  | Vertical spacing between turns is loose/uneven                                                             | Regularize the rhythm; deliberate, consistent gaps                      | polish | CC     | OPEN                              |
| B4  | Assistant **name tag repeats on every reply**                                                              | Show once per consecutive assistant group                               | polish | CC     | OPEN                              |
| B5  | User bubble glass is a touch heavy                                                                         | Keep glass but subtle (GPT: "not too heavy")                            | polish | GPT+CC | OPEN                              |

## C. Composer

| #   | What's off                                                                                                    | Fix                                                            | Phase | Source | Status |
| --- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----- | ------ | ------ |
| C1  | ✅ ~15 `zinc-*` usages (slash-command chips `:227/253`, attachment chip `:267` `border-zinc-700 bg-zinc-900`) | Sweep to tokens; attachment chips to the glass/`--line` recipe | B5    | GPT+CC | OPEN   |
| C2  | Keep composer stable, no model/provider noise (already moved to header — hold the line)                       | Guard against regressions                                      | —     | GPT    | WATCH  |

## D. One design language — unify ALL overlays (GPT P1 = canon P1 #7)

| #   | What's off                                                    | Fix                                                                                                                    | Phase    | Source    | Status |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------- | --------- | ------ |
| D1  | Overlays don't all share one glass/scrim/radius/easing recipe | One recipe for: model picker, message-action `SullySheet`, sidebar drawer, RunSheet, voice settings, attachment picker | B/polish | GPT+canon | OPEN   |

## E. Voice mode (Phase C — its own milestone)

| #   | What's off                                                                 | Fix                                                                                                                                                                                                                            | Phase | Source | Status |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ | ------ |
| E1  | Mic/mute button still reads as the hero; layout feels like a control panel | **Orb is the hero**; bottom glass dock = `[keyboard] · waveform · [mute]`; captions optional (Gemini-Live feel). NB: an orb + live transcript already exist in `VoiceMode.svelte` — this is layout/hierarchy, not from scratch | C     | GPT+CC | OPEN   |

## F. Motion mechanics (governed by the motion-engine doc — the current blocker)

| #   | What's off                                                                                                                                 | Fix                                                                                        | Source      | Status                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------- | ------------------------ |
| F1  | ✅ Model-picker swipe **snaps** instead of continuing from the finger (`externalExit` discards drag position → CSS keyframe restarts at 0) | Spring source-of-truth; release continues from finger + injects velocity                   | operator+CC | OPEN — motion-engine doc |
| F2  | ✅ Sidebar close **flickers** + too fast/asymmetric (`@keyframes …forwards` + `setTimeout` unmount = WebKit 1-frame flicker)               | Spring (or transition-on-state-class); unmount on rest not timeout; symmetric in/out       | operator+CC | OPEN — motion-engine doc |
| F3  | Scroll not verified smooth; `scrollTo({behavior:'smooth'})` is janky on iOS (kills momentum)                                               | `-webkit-overflow-scrolling:touch` + instant-when-pinned + custom rAF for deliberate jumps | CC research | OPEN — motion-engine doc |

## G. Native iPA shell (Phase D — CC)

| #   | What                                                                                                                                 | Source                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| G1  | Haptics as seasoning: send=light, sheet=light, voice-enter=light, approval=medium/success, worker-failed=warning, destructive=medium | GPT+CC research (matches Pattern 4) |
| G2  | Capacitor Keyboard plugin: explicit composer tracking (don't rely on CSS alone)                                                      | GPT+CC research                     |
| G3  | Status-bar style + safe-area proof on real iPhone + TestFlight device screenshots                                                    | GPT+canon                           |

---

## The flagship test (GPT's rule — adopt as the done-bar)

> Could a normal iPhone user open this app, not knowing LogueOS exists, and immediately understand how
> to talk to Sully? If the screen shows CORE / HOST / raw worker or provider names / thread slugs /
> debug labels / permanent tool controls in the normal shell — it's still too internal.

## The verification lesson (locked in)

Motion and feel **cannot be screenshot-verified** and **cannot be code-reviewed** — GPT's review (code-read
only) missed the fluidity blocker entirely; the operator's on-device testing caught it. So every motion/feel
item is verified by (a) on-device hands-on and (b) instrumented gesture sampling, never a static screenshot.

## Convergence note

The hybrid canon, Cursor's visual plan, and the independent GPT review **all converge** on the same
priority order (consumer shell → unify overlays → voice → native). High confidence in the direction;
this list is the finish detail under it.
