# Sully Work Surface — Build Spec

**Status:** Approved direction (operator, 2026-06-06). The build blueprint AND the
labeling scheme for the local-Sully training corpus.

---

## DOCTRINE (locked 2026-06-06 — operator + GPT + CC consensus)

> **Sully is Dynamic Island + Cursor, wrapped in Vision Pro materials.**
> **Glance first.** Motion is reality. Everything else is follow-up.
> **The next pass is subtraction.**

**The two glance questions** (the surface answers ONLY these two without scanning):

1. **What is going on?** → status pill + ring + Next banner
2. **Who is doing what now?** → one worker row per active worker, no nesting

Everything else (Timeline, Proof, Registry, Memory, Logs, Activity stream) lives
in collapsed accordions below. Never on glance.

**Operating rules (each resolves a class of future micro-decisions):**

- **GLANCE FIRST.** Before adding any element, ask: does this help the two glance
  questions, or does it serve completeness? If completeness — collapse it.
- **Motion is reality or it isn't there.** Every loop, pulse, waveform, fill must
  bind to a real system signal (event count, completion %, elapsed wait, tool
  type). Decoration-without-binding is forbidden — it's the trap that bit every
  previous pass. The phrase to engrave: _Motion is reality._
- **Presence by absence.** Signal earned by what isn't there: the Sully pill is
  absent when idle (not a dot, not "0 workers" — gone). The Approve/Stop row
  is absent when no action is available. **The appearance of an element is the
  event.**
- **One row each, no nesting.** Worker rows are flat: `[shortcode] [waveform] [action]`.
  No tree, no collapse, no sub-rows. Drill-down lives below the card.
- **Subtraction over addition.** The next pass removes; it does not add. New
  widgets are weighed against what they would replace.

This doctrine ranks above the rest of this spec. If anything below conflicts
with it, the doctrine wins.

---

**Backed by two convergent investigations** (read for full detail):
`data/peer_reviews/2026-06-06_frontend-audit-cdx.md` (code) +
`data/peer_reviews/2026-06-06_motion-concurrency-research.md` (field).

---

## 0. The reframe

Sully is an **operator cockpit** — a live window into a multi-worker system doing
work — with chat/voice as one lane in. Not a companion chat buddy (that persona
survives only in the chat/brainstorm lane; the avatar leaves the cockpit). The
**Work Surface is the product**, not a feature.

The same loop serves three ends at once: the visible dispatch IS the product UX, IS
the operator's window, AND IS the routing/planning training data for local Sully.

---

## 1. Surface-state model (the foundation — build first)

Everything below renders off this. A single Svelte 5 store of surfaces; motion +
dock are pure functions of state.

```ts
type SurfaceStatus = 'idle' | 'running' | 'needs-you' | 'done' | 'failed';
type EdgeStatus = 'pending' | 'active' | 'solid'; // dependency → flowing → landed

interface Surface {
	surfaceId: string; // STABLE — the conversation references this to attach
	spawnedFromMessageId: string; // provenance: which turn created it
	title: string;
	status: SurfaceStatus;
	workers: WorkerNode[]; // role + identity + per-worker status
	routing: RoutingGraph; // nodes + edges (edges carry EdgeStatus)
	stage: StageKey; // READ/RESEARCH/BUILD/CHECK/APPROVE/REPLY
	needs?: { kind: 'approval' | 'input'; prompt: string }; // what it's blocked on
	proof?: ResultInfo;
	createdAt: string;
	updatedAt: string;
}
```

Rules: motion is driven ONLY by status/edge transitions (never by layout). Status
changes happen in place; translation is reserved for _causation_ (spawn, regroup).

## 2. Dock architecture

- **Conversation = constant spine** (chat + voice → one state; never blocks on work).
- **Surfaces live in a dock**, not inline. Collapse ladder (Arc/Slack pattern):
  **badge** (`▶2 ⏸1`) → **rail** (compact live rows) → **one expanded detail**.
- **Grouped by state: Running / Needs-you / Done.** Done auto-fades to gray after
  ~10s but stays scrubbable (replay), never deleted.
- **One expands at a time** (accordion). N surfaces stay contained.
- **Optimistic spawn:** row appears instantly (gray "syncing"), then running/failed.
- **Attach-vs-spawn:** a turn attaches to an existing `surfaceId` (brief glow on that
  row — reuse the dispatch land-beat) or spawns new. No duplicate cards.

## 3. Routing rule (operator's rule + refinements) — and the labeling scheme

Default OFF: no surface spawns from casual conversation. Implement as **intent
classification** (not keyword match — the example phrases are few-shot signals) using
**utterance + conversational state**. `decide()` has four outcomes:

| Signal                                                                                     | Outcome                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| imperative verb + concrete deliverable ("research X", "make the mockup", "audit the repo") | **spawn**                                   |
| affirmation after Sully's own proposal ("yeah", "go", "do it")                             | **spawn** (attach to proposal)              |
| reference to a live surface ("how's that research", "check on it")                         | **attach**                                  |
| hypothetical / musing / past / 3rd-person ("we should…", "it'd be cool…")                  | **talk** (+ passive offer chip)             |
| imperative, vague target ("look into that")                                                | **ask** (chat: silent chip · voice: 1-beat) |

**Propose liberally, dispatch conservatively:** decouple _surface appears_ from _work
starts_. Three tiers — clear → spawn+auto-start; probable → spawn **armed** (one tap /
short grace to start); ambiguous → passive one-tap offer (no blocking question).
**Voice biases harder to not-interrupt** (defer to a chip, never a modal question).
A lightweight **Brainstorm ↔ Execution** soft-mode (operator-settable) shifts the
threshold and removes most ambiguity at the source.

**Labeling:** every decision + the operator's reaction (confirmed / undone / ignored /
attach-vs-spawn) is a labeled intent example → local Sully learns the operator's
phrasing. The keyword list is the bootstrap; the model is the goal.

## 4. Motion language (every animation maps to an event)

Summary (full table in the research report §1). The fix for "the square with no
purpose": motion was keyed to layout; rebind to events.

| Event            | Motion                                                                       | Quiet when                         |
| ---------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| dispatch (spawn) | surface scales/fades up FROM its chat message; 1 border-glow pulse on settle | existing surfaces hold             |
| data-flow        | edge `stroke-dashoffset` marches upstream→downstream (linear loop)           | edge solid+static once landed      |
| worker-active    | node opacity breathe in place                                                | steady dot when idle               |
| completion       | green dot + one expansion ring (the land beat)                               | total stillness; fade to gray ~10s |
| needs-you        | amber pulse + slide to top of Needs-you group                                | stops on operator response         |
| failure          | red dot + reverse-dash + one shake                                           | static red row; never loops        |
| idle             | nothing (0.4-opacity dot)                                                    | default — silence is information   |

One transform property per animation; glow via `stroke-dasharray`+opacity, never
`box-shadow`. Sustained states loop; transitions are one-shot.

## 5. Palette (shipped 2026-06-06)

Identity = **muted rose `#cf6f93`** (mark, focus ring, one hero action — never status).
Status = muted semantic tokens (`--color-st-run` calm blue, `-needs` amber, `-done`
gray, `-fail` rose, `--color-edge[-active]`). Pair colour with icon + label; cap
concurrent bright signals.

## 6. Component stack

**Hand-rolled SVG + Motion One (~18KB).** Skip Svelte Flow (built for big pan-zoom
DAGs we don't have; fights brand motion) and Rive (theme colors baked in). Keep the
surface state **renderer-agnostic** so Svelte Flow can layer in later for an optional
free-canvas DAG mode. Lazy-load GSAP only for a specific "big moment" if ever needed.

## 7. Build sequence (DO-FIRST → dispatched in order, visible on :8455)

1. **Surface-state model** (§1) — store + types. Foundation; everything depends on it.
2. **The dock** (§2) — spine + grouped rail + collapse ladder + one-expands; render the
   existing `WorkSurfaceCard` in the expanded slot; seed 2–3 concurrent surfaces.
3. **Event-driven motion** (§4) — rebind WorkGraph to state transitions; kill the
   layout fly-in; idle quiet.
4. **Real node icons + cockpit framing** (§5 audit) — replace placeholder dots; restore
   "Next:".
5. **Needs-you first-class** (§2) — blocked state + inline prompt on the spine.
6. **Routing rule + attach/spawn** (§3) — wire `decide()` four-outcome + labeling.

Chunks 1–2 dispatched first (the dock can't render motion until state exists).
