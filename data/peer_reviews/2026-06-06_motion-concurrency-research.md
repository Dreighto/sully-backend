I have all the research I need synthesized in the prompt. This is a synthesis-and-writing task, not a research task. Let me produce the report directly.

# Sully Work Surface — Motion, Concurrency & Stack Recommendation

Practical synthesis of the five research streams (workflow-anim, agent-exec-ui, concurrency-ux, svelte-stack, dense-contained) into a buildable spec. Opinionated by design.

---

## 1. Recommended Motion Language

**Core principle (this fixes the complaint):** *Motion is a state signal, never decoration.* The operator's gripe — "a square flies in from the left with no purpose" — happens when motion is keyed to *layout* (an element appearing) instead of to a *system event*. Every animation below is bound to a named event in the dispatch pipeline. If no event fired, nothing moves. This is the n8n 2.0 thesis ("motion *is* the new debugger" — blog.n8n.io) and Temporal's two-channel encoding (color + motion together — Temporal UI redesign blog).

The fly-in-from-left is wrong on two counts: (a) horizontal translation implies spatial origin the data doesn't have, and (b) it animates *arrival* rather than *causation*. Replace it with **origin-anchored emergence**: a new surface scales/fades up *from the conversation message that spawned it* — the motion's vector encodes "this came from that turn."

| Event | What moves | Direction / origin | Easing | The "land" beat | When it's quiet |
|---|---|---|---|---|---|
| **dispatch** (turn spawns a surface) | New surface card scales 0.92→1 + fade 0→1 | Emerges *at* the spawning chat message, settles into the dock — NOT a horizontal fly-in | `cubic-bezier(.2,.8,.2,1)` (decelerate) ~260ms | Single 1px border-glow pulse on settle, then still | Existing surfaces hold position; no reflow jitter |
| **data-flow** (surface awaiting upstream) | Connector edge: `stroke-dashoffset` marching forward along the edge | Upstream→downstream, 2–3s linear loop | `linear` (continuous, not eased — it's a flow not a gesture) | None — it loops until the dependency resolves | Edge goes solid + static the instant data lands |
| **worker-active** (running) | Node/row: opacity breathe 0.85↔1.0, ~1.6s | In-place, no translation | `ease-in-out` sine | n/a (sustained heartbeat) | Drops to a single steady-state dot when idle/done |
| **completion** (success) | Status dot green; one expansion ring (scale 1→1.4, fade out) | Radial from the dot | `ease-out` ~400ms, fires once | The ring IS the land beat — then total stillness | Row settles to gray within ~10s (auto-fade, Arc/Chrome dock) unless pinned |
| **needs-approval / needs-you** | Row border + dot pulse amber, slow ~2s; row lifts to top of "Needs-you" group with a 200ms slide | In-place pulse; group-reorder slide | Pulse `ease-in-out`; reorder `cubic-bezier(.2,.8,.2,1)` | Pulse is sustained (it's a standing request, not a moment) | Stops the instant operator responds; row slides to Running |
| **failure** | Dot red; edge → dashed red marching *backward* (reverse `dashoffset`); one short shake (±2px, 1 cycle) | Reverse-flow on the edge signals "stuck here" | Shake `ease-out` once, ~180ms | The single shake, then sustained red dash | Settles to static red row in error group; never loops the shake |
| **idle** | Nothing. Steady 0.4-opacity dot. | — | — | — | This is the default. Silence is information. |

**Hard rules:**
- **One transform property per animation.** Animate `opacity`, `transform`, or `stroke-dashoffset` — never `box-shadow`/`filter: blur` (bloom artifacts + GPU cost on near-black, per dense-contained finding 7). Glow = `stroke-dasharray` + opacity, not shadow.
- **Reserve translation for causation.** Horizontal/vertical slides only when they encode a relationship (spawned-from, reordered-into-group). Status changes happen *in place*.
- **Sustained vs. one-shot discipline.** Standing states (running, pending, needs-you, failed) get *loops*; transitions (dispatch, completion) get *one-shot land beats*. Never loop a "moment."
- **`transform: translate3d(0,0,0)` + `will-change: transform`** on animated edges only (svelte-stack finding 7). Don't blanket-apply `will-change`.

---

## 2. Concurrency UX Model

**Verdict on the proposed model: validated, with three refinements.** The proposal — conversation as constant spine; surfaces in a glanceable dock of compact rows grouped Running / Needs-you / Done; one expands at a time; turns spawn-new or attach-to-existing via stable IDs — is the correct architecture and is strongly backed by the research. "Docks beat queues" is the dominant finding across all ten concurrency-ux sources (Apple Live Activities, Arc downloads, Chrome, n8n, Linear, Figma, Slack). A queue implies a *bottleneck* and *waiting*; a dock implies *concurrent flow* — exactly the multi-agent feel Sully needs.

**Why the spine + dock is right:**
- **Conversation = constant spine** matches Devin's "Progress tab stays anchored, tool panes swap" and GitHub Copilot Mission Control's "session logs inline with task status." The operator never loses the conversational thread that *caused* the work.
- **Grouped Running / Needs-you / Done** maps directly to Linear's In-Progress swimlane and Chrome/n8n status-grouping. Grouping by *state* (not by worker type) is the universal pattern — state is the operator's first question.
- **One expands at a time** is the accordion focus-one-expand-rest pattern (dense-contained finding 6) and Vercel's progressive disclosure (overview→detail). Prevents N full-height cards sprawling.
- **Stable IDs / attach-to-existing** is the single most important detail and is under-emphasized in most tools. It's what lets optimistic spawning (Figma/Linear/Slack pattern) work: a turn that says "also check the tests" attaches to the *existing* surface rather than spawning a confusing duplicate.

**Three refinements (cited):**

1. **Make the dock collapse to a count-badge, not just shrink.** Arc's download dock collapses to `3↓`; Slack's huddle bar collapses to a count. Sully's dock should have three states: **badge** (`▶2 ⏸1`) → **rail** (4–5 compact rows) → **row-expanded** (one surface's detail). This is the collapse→list→detail ladder that scales from 2 to 20+ surfaces without redesign.

2. **Promote "Needs-you" out of the dock when it's urgent.** Cursor 3's Agents Window treats *Paused–needs input* / *Paused–needs approval* as **first-class explicit states, not "loading."** When a surface needs the operator, the row should pulse amber AND surface a compact prompt inline on the spine (Copilot's "steering" input pattern). The operator should never have to *hunt* for which surface is blocked. Show **what** it's waiting for ("waiting: approve `git push`"), not just "paused."

3. **Auto-fade Done, but keep a scrubbable timeline.** Done rows fade to gray after ~10s (Arc/Chrome) — but don't *delete* them. Devin's timelapse/replay is the trust-builder: let the operator scrub a completed surface backward to see what the agent did. A thin "Done (3)" collapsed group with replay-on-expand satisfies both glanceability and post-hoc audit.

**Spawning behavior (resolve the ambiguity):**
- A turn **spawns-new** when its intent has no existing surface (new task, new repo target).
- A turn **attaches** when it references an in-flight surface ("also…", "while you're in there…", a follow-up on the same task ID). Use the conversation's referent resolution + stable surface IDs. On attach, the existing row gets a brief 1px glow pulse (the "dispatch" land beat, reused) so the operator sees *where* the new instruction landed — no new card flies in.
- **Optimistic spawn:** the surface row appears in the dock *immediately* on send with a gray "syncing…" dot, then turns green/running on confirmation, or red-retry on failure (Figma/Linear/Slack optimistic UI). Spawning must feel instant, not queued.

**Layout:** spine (conversation) holds ~65% width; dock is a right-side rail (Arc downloads position) at ~35%, collapsible to a 48px badge strip. On mobile/phone, the dock becomes a Dynamic-Island-style pill at top that expands to a sheet.

---

## 3. Component-Stack Recommendation

**Pick: hand-rolled SVG + Motion One as the primary, with Svelte Flow held in reserve for a future free-canvas mode.** This is a deliberate reversal of the svelte-stack report's "Svelte Flow primary" default — and here's why it's right *for Sully specifically*.

**Rationale:**
- Sully's surfaces are a **dock of compact rows with a few connector edges**, not a 200-node free-pan-zoom DAG. The thing Svelte Flow is *best* at (GPU pan/zoom over hundreds of nodes, auto-layout physics) is the thing Sully **does not need** for the core work surface. Paying 45–52KB + a component-remount cost for theme switches (svelte-stack finding 9: Svelte Flow needs ~100ms re-mount for instant brand variants) to get capabilities you won't use is the wrong trade.
- The motion language in §1 is **custom and brand-critical**: origin-anchored emergence, reverse-flow failure edges, sustained-vs-one-shot discipline, near-black glow via `stroke-dasharray`. svelte-stack finding 2 + 9 are explicit: hand-SVG + Motion One is **"unbeatable for brand consistency"** and wins for **instant CSS-variable theme switching at zero runtime cost** — exactly the muted-dark restraint §4 demands. Svelte Flow makes you fight its defaults; hand-SVG makes the brand the default.
- **Bundle:** ~15–18KB (Motion One v1.0.1 + SVG utils) vs 52KB. Add Panzoom (+8KB) *only if* the future free-canvas mode ships. Motion One is a thin Web Animations API wrapper → future-proof, native Svelte 5 `$state`/`$effect` integration.

**When to reach for each:**
- **Hand-SVG + Motion One** → the Sully work surface dock, connector edges, all the §1 motion. **This is the build-now pick.**
- **Svelte Flow (@xyflow/svelte v12)** → *only* if/when you add a "spread it out on a canvas" mode showing the full multi-agent DAG with free pan/zoom over 50+ nodes. It's the battle-tested choice there (n8n/Zapier/Retool production). Architect the surface-state model to be renderer-agnostic so this can layer in later without a rewrite.
- **Rive** → **skip.** svelte-stack findings 4 + 9: 100KB runtime, colors baked into `.riv` (no instant dark-theme switching, requires designer re-export per variant), API volatility. Sully's status icons are simple state machines (idle/running/needs-you/error) that CSS + Motion One handle in <1KB with full theme control. Rive only earns its weight if a designer needs to author genuinely complex per-icon animations without code — not Sully's situation.
- **GSAP** → optional accent *later* for "big moment" staggered cascades (e.g., a multi-worker fan-out establishing). 35KB is too much to load for the baseline; lazy-load it if a specific moment justifies it. Don't put it in the core bundle.

**Recommended baseline bundle: ~18KB** (Motion One + SVG utils). Compare to svelte-stack's "balanced 70KB" — Sully's narrower scope earns the lighter stack.

---

## 4. Color / Restraint

**The magenta (`#ec2d78`) is too loud as a motion/status accent — agreed.** The operator's own canon already flags this instinct ("motion = signal, bright = decoration" — workflow-anim; and the operator-console-ui discipline). The fix isn't to abandon the brand magenta — it stays as Sully's *identity* accent (composer focus ring, brand mark, the one hero element). It must NOT be the language of *state*.

**What the best pro tools do (cited):**
- **Linear, Vercel, Datadog, Oh Dear** all use **muted, desaturated functional status colors on near-black**, paired with **icon + shape + text label** — never color alone (dense-contained findings 4, 8; Carbon Design System status pattern). Carbon's rule: icon + shape + color + label, capped at 5–6 concurrent indicators per view.
- **On near-black, saturation reads as alarm.** A fully-saturated magenta or red vibrates against `#020617`. Pros desaturate and lower lightness so status colors *sit in* the dark rather than punching through it.

**Sully status palette (muted, dark-tuned):**

| State | Token | Hex (muted on near-black) | Pairing |
|---|---|---|---|
| Background | `--bg` | `#050505` → `#0a0e14` | base |
| Running / active | `--st-run` | `#5b8db8` (muted blue, not green) | breathe + ▶ icon |
| Needs-you | `--st-wait` | `#c9a34e` (muted amber, NOT bright yellow) | pulse + ⏸ icon + label |
| Failure | `--st-fail` | `#c25b5b` (desaturated rose, not `#ff0000`) | reverse-dash + ✕ icon |
| Complete / idle | `--st-done` | `#6b7280` (gray) | static dot |
| Data-flow edge | `--edge` | `#2a2f3a` base, `#3d4a63` active | dash march |
| **Brand magenta** | `--brand` | `#ec2d78` | **identity only** — focus ring, mark. Never a status. |

**Restraint rules:**
- Avoid bright yellow entirely — use muted amber with a dark icon overlay (Oh Dear pattern).
- Status color always paired with icon + (on the active/blocked states) a text label. Color-blind safe + glanceable at 200ms.
- Glow on dark = `stroke-dasharray` + low-opacity stroke, **never** `box-shadow` bloom.
- Cap concurrent bright signals: at most the *one* amber needs-you and *one* red failure should pulse at once; everything else is quiet (Carbon's 5–6 cap).

---

## 5. DO-FIRST 5 (ranked by leverage)

1. **Bind every animation to a system event, kill all layout-triggered motion.** Build the surface-state model (`idle | running | needs-you | done | failed` + edge `pending | active | solid`) and drive *all* motion off state transitions. This single change fixes the "square flies in for no reason" complaint at the root — replace the horizontal fly-in with origin-anchored scale/fade emergence from the spawning chat message. Highest leverage because it's the operator's actual stated pain and everything else builds on a clean state model.

2. **Ship the dock: conversation spine + right-rail grouped Running / Needs-you / Done, collapse→rail→detail, one-expands-at-a-time.** This is the structural backbone. "Docks beat queues" — adopt the Arc/Slack collapse-to-badge ladder and Linear state-grouping. Without this, motion polish has nowhere to live.

3. **Re-palette to muted functional status colors; demote magenta to identity-only.** Swap saturated status colors for the dark-tuned table in §4, pair every status with icon + label, ban `box-shadow` glow. Fast to do (CSS variables), immediately makes the surface feel pro instead of loud, and is prerequisite for the motion in #1 reading correctly on near-black.

4. **Make "Needs-you" first-class: explicit blocked state + inline prompt on the spine + amber pulse + auto-reorder to top of group.** Cursor 3 / Copilot steering pattern. This is the highest-trust, highest-utility interaction in a multi-agent cockpit — the operator must instantly see *which* surface is blocked and *what on*, without hunting. Show the waited-on thing ("approve `git push`"), not "paused."

5. **Lock the stack at hand-SVG + Motion One (~18KB) with renderer-agnostic surface state.** Commit to the light, brand-controllable stack now; architect the state model so Svelte Flow can layer in later for an optional free-canvas DAG mode. Prevents both over-engineering (don't pull Svelte Flow/Rive you won't use) and a future rewrite. Skip Rive; lazy-load GSAP only if a specific "big moment" later justifies it.

---

*Sources cited inline: n8n 2.0 (blog.n8n.io), Temporal UI redesign blog, LangSmith Studio, Dify, Prefect 3.0, Flowise/LangGraph, Cursor 3 "Glass" Agents Window, Devin progress/timelapse, GitHub Copilot Mission Control, Claude/ChatGPT extended thinking, Vercel v0, Apple Live Activities/Dynamic Island, Arc/Chrome download docks, Linear, Figma, Slack, Datadog, Vercel Observability, Grafana, Oh Dear, Carbon Design System, Observable Framework, @xyflow/svelte v12, Motion One v1.0.1, Rive v5, GSAP v3.12, D3-force v3.*