# Polish Audit — Sully Work Surface (External)

**Audited:** `LogueOS-Companion` @ `main`  
**Date:** 2026-06-06  
**Scope:** Work-surface component set per `external_audit_prompt.md`  
**Mode:** read-only code audit — no repo changes

---

## Verdict

The work-surface stack is **polish-grade and close to ship-quality**. Svelte 5 runes discipline is mostly correct, motion is overwhelmingly state-gated (a major improvement over earlier passes), and the doctrine patterns (presence-by-absence indicator, collapsed accordions, earned-rest breath) are implemented with intentional comments. Real gaps are **subtraction debt** (dead imports/props/CSS), a few **token/hardcode inconsistencies**, one **action-row behavioral mismatch** between compact and expanded footprints, and **WorkerRegistry** still routing Build highlights through `--color-brand` (identity token used as role/status paint). None are blockers; all are quick polish fixes.

---

## CSS findings

### Token discipline

| Finding | File:Line | Impact | Fix |
|---------|-----------|--------|-----|
| Arbitrary property syntax for theme colors instead of Tailwind utilities | `WorkSurfaceDock.svelte:150,176,202,162,188,214` — `text-[--color-st-run]`, `text-[--color-brand]` | Works at runtime but bypasses the `@theme` utility pipeline; harder to grep and inconsistent with `bg-st-run` used elsewhere | Replace with `text-st-run`, `text-st-needs`, `text-st-done`, `text-brand` (all defined in `@theme`) |
| Hardcoded hex outside `@theme` | `WorkGraph.svelte:460,492,564,573` — `#0ea5e9`, `#fcd34d`, `#fca5a5` | Drift from cockpit palette; researching sweep/packet color won't track token updates | Map to `--color-status-blue`, `--color-status-amber`, `--color-status-red` (or add `--color-st-*` aliases if the muted cockpit values are intentional) |
| Hardcoded worker identity hex (duplicated in two files) | `WorkerRow.svelte:23-27`, `WorkGraph.svelte:151-155` | Same mapping maintained twice; neither uses existing `--color-worker-*` tokens in `app.css:44-46` | Extract one `workerBrandColor(identity, shortCode)` helper + add missing worker tokens (CC orange, AGY purple, CDX gray, DPSK blue) to `@theme`, or reference CSS vars |
| Likely no-op shadow utilities | `WorkerRegistry.svelte:105-114` — `shadow-status-blue`, `shadow-brand`, `shadow-status-purple`, `shadow-status-red` | No `--shadow-*` entries in `app.css`; Tailwind 4 won't emit these unless custom-defined — dot glow may silently not render | Either define shadow color tokens in `@theme` or drop shadows and rely on border/opacity signals (subtraction-friendly) |
| `bg-status-green` vs semantic `--color-st-done` split | `WorkSurfaceCard.svelte:264,333`, `WorkSurfaceIndicator.svelte:130`, `SurfaceProgressRing.svelte:30,102` | Complete/success uses bright `#22c55e` while idle/done status uses muted gray `--color-st-done` — two "done" visual languages | Accept if intentional (celebration = bright green, idle = gray); otherwise unify Complete ring/glow on `--color-st-done` or document the dual palette in `@theme` comments |

### Brand vs status discipline

| Finding | File:Line | Impact | Fix |
|---------|-----------|--------|-----|
| Build role highlights use brand token | `WorkerRegistry.svelte:12,87-88,107-108` — `bg-brand/10`, `border-brand`, `shadow-brand` for active Build workers | Violates locked rule: `--color-brand` is identity-only, not a worker/status colour. Reads as "Sully is building" not "AGY is building" | Switch Build highlights to `--color-status-purple` or the per-worker brand hex already used in `WorkerRow`/`WorkGraph` (operator-locked 2026-06-06) |
| Worker short codes in dock use brand colour | `WorkSurfaceDock.svelte:162,188,214` — `text-[--color-brand]` on every row's monospace code | Over-applies identity colour to telemetry; every worker looks "Sully-branded" | Use `text-muted-foreground` default; colour only the status dot, or use per-worker colour from the shared helper |

### Animation correctness

| Check | Result |
|-------|--------|
| `SurfaceProgressRing` `rest-breath` gated on `inEarnedRest` | **PASS** — `SurfaceProgressRing.svelte:93,137-139` |
| `WorkSurfaceCard` `rest-glow` only on `.status-complete` | **PASS** — `WorkSurfaceCard.svelte:263-271` |
| `WorkerRow` `wave-active` only when active | **PASS** — bars render + animate only inside `{#if wState === 'active'}` at `WorkerRow.svelte:55-60` |
| `WorkGraph` sweep/packets only when `dispatch_active` | **PASS** — `{#if route.hasSweep && … && route.dispatch_active}` and `{#if route.dispatch_active}` at `WorkGraph.svelte:286-299`; `allRoutes` returns `[]` when settled at `165-167` |
| `WorkSurfaceIndicator` pulse only with running/needs-you work | **PASS** — pill absent when idle (`101`); dots gated on `hasRunning` / `hasNeedsYou` (`111-127`); recent-complete one-shot is event-driven (`37-50`) |
| `StageTimeline` connector march only while `Working` | **PASS** — `StageTimeline.svelte:27,159-165` |
| `PhaseChecklist` active dot breath | **PASS** — only on `.phase-row.active` at `71-74` |

**Stale comment (not a bug):** `WorkSurfaceIndicator.svelte:7-8` still says "muted-rose dot" but running dot is `bg-st-run` (calm blue). Update comment to match implementation.

### Mobile parity

| Finding | File:Line | Impact | Fix |
|---------|-----------|--------|-----|
| `WorkerRow` active waveform is drop-shadow-only glow | `WorkerRow.svelte:118` — `filter: drop-shadow(0 0 3px currentColor)` with no ring/stroke fallback | On iOS WebKit the waveform may read flat compared to graph nodes (which have 3-signal fallback) | Mirror graph pattern: bump rect opacity/height on active **or** add a non-filter highlight (e.g. brighter fill on center bar) |
| `SurfaceProgressRing` celebration uses drop-shadow | `SurfaceProgressRing.svelte:157` | Acceptable — one-shot, not a loop; low risk | No change required |
| Safe-area handling in dock badge | `WorkSurfaceDock.svelte:86` — `pr-[max(env(safe-area-inset-right),1rem)]` | **PASS** — correct iOS PWA pattern | — |

### Performance

| Finding | File:Line | Impact | Fix |
|---------|-----------|--------|-----|
| Continuous `box-shadow` animation on Complete card | `WorkSurfaceCard.svelte:271,273-280` — `rest-glow` infinite | GPU-expensive vs transform/opacity; runs for entire Complete dwell | Doctrine-bound (earned rest), so keep — but consider animating a pseudo-element's `opacity` only and setting a static soft shadow, if profiling shows jank on iPhone |
| Continuous `stroke-width` animation on ring | `SurfaceProgressRing.svelte:137-149` | Moderate — SVG stroke-width triggers repaints | Acceptable for single hero ring; watch if multiple rings on screen |
| `WorkerRow` continuous `filter: drop-shadow` on 5 rects | `WorkerRow.svelte:111-118` | 5 filtered rects × N workers in expanded view | Gate is correct (active only); if perf issues, drop filter and use height animation only (already transform-friendly) |
| `prefers-reduced-motion` respected in graph | `WorkGraph.svelte:599-605` | **PASS** | — |

### Unused selectors

| Finding | File:Line | Impact | Fix |
|---------|-----------|--------|-----|
| Dead CSS blocks in card (no matching markup) | `WorkSurfaceCard.svelte:365-367,373-375,454-468,480-486` — `.system-badge-icon`, `.card-label`, `.expanded-header`, `.close-expanded-btn`, `.expanded-details-layout`, `.proof-card` | Svelte may warn; adds noise for reviewers | Delete unused rules (doctrine: subtraction) |
| Dead `$derived` helper | `WorkGraph.svelte:159-162` — `getNodePos` never referenced | Dead code; `$derived((id) => …)` stores a function value — wrong pattern if ever consumed | Remove entirely |

---

## JS / Svelte 5 findings

### Runes

| Finding | File:Line | Impact | Fix |
|---------|-----------|--------|-----|
| Module store getters wrapped correctly | `WorkSurfaceDock.svelte:36-38`, `WorkSurfaceIndicator.svelte:27-29`, simulator `401-403` | **PASS** — `$derived(running())` pattern | — |
| No `$derived(() => fn())` bug found | — | **PASS** | — |
| `getNodePos` dead `$derived` callback | `WorkGraph.svelte:159-162` | Latent foot-gun | Remove |

### Reactivity

| Finding | File:Line | Impact | Fix |
|---------|-----------|--------|-----|
| `surfaces.svelte.ts` exports functions not arrays | `surfaces.svelte.ts:44-52` | **PASS** | — |
| `attachToSurface` shallow-merge may drop nested task fields if caller passes partial `task` | `surfaces.svelte.ts:25` | Simulator always passes full `task` — OK today; real backend patches could accidentally wipe nested arrays | When wiring live SSE, patch with deep merge on `task` or require full task snapshots |

### Type safety

| Finding | File:Line | Impact | Fix |
|---------|-----------|--------|-----|
| `wState` widened to `string` for unreachable `'waiting'` branch | `WorkerRow.svelte:11` | Bypasses `WorkerStatus`; `'waiting'` is not in the type contract | Remove widening; use `'queued'` or add `'waiting'` to `WorkerStatus` in `workSurface.ts` if backend needs it |
| `(task.state as string) === 'Idle'` | `WorkGraph.svelte:269` | `Idle` is not in `TaskState` union | Remove cast branch or add `'Idle'` to `TaskState` if backend sends it |
| `GraphEdge` dual keys `dispatchActive` / `dispatch_active` | `WorkGraph.svelte:234`, `workSurface.ts:105-106` | Defensive but untyped snake_case on TS interface | Pick one canonical field; keep a normalizer at the API boundary |

### Effect cleanup

| Finding | File:Line | Impact | Fix |
|---------|-----------|--------|-----|
| `SurfaceProgressRing` `prevState` plain `let` | `SurfaceProgressRing.svelte:45-58` | **PASS** — correct non-reactive transition pattern | — |
| `WorkSurfaceIndicator` completion flash timer cleanup | `WorkSurfaceIndicator.svelte:37-50` | **PASS** — `return () => clearTimeout(timer)` | — |
| `WorkSurfaceCard` approve confirm timeout not cleared on unmount | `WorkSurfaceCard.svelte:29,50-53` | Minor leak if card destroyed mid-confirm | Add `$effect` cleanup or `onDestroy` to `clearTimeout(approveTimeout)` |
| Simulator driver interval cleared on reset | `work-surface-flow-simulator/+page.svelte:352-364,387-390` | **PASS** | — |

### A11y

| Finding | File:Line | Impact | Fix |
|---------|-----------|--------|-----|
| `SurfaceProgressRing` `role="img"` + `aria-label` | `SurfaceProgressRing.svelte:70-71` | **PASS** | — |
| `WorkerRow` waveform `role="img"` + label | `WorkerRow.svelte:52-53` | **PASS** | — |
| Dock/sheet rows are real `<button>`s | `WorkSurfaceDock.svelte:152-170` etc. | **PASS** | — |
| Sheet tap-out overlay is `<div role="button">` | `WorkSurfaceDock.svelte:238-250` | Works with keyboard handler; acceptable | Prefer `<button type="button" class="absolute inset-0 …">` for semantics |
| Accordion buttons have `aria-expanded` | `WorkSurfaceDock.svelte:292,310,…` | **PASS** | — |

### Tap targets

| Finding | File:Line | Impact | Fix |
|---------|-----------|--------|-----|
| Indicator pill `h-11` (44px) | `WorkSurfaceIndicator.svelte:105` | **PASS** | — |
| Action buttons `min-h-[44px]` | `WorkSurfaceCard.svelte:431` | **PASS** | — |
| Dock list rows `min-h-[44px]` | `WorkSurfaceDock.svelte:154` | **PASS** | — |
| Sheet close `h-11 w-11` | `WorkSurfaceDock.svelte:259` | **PASS** | — |
| Simulator Start/Reset buttons lack `min-h-[44px]` | `work-surface-flow-simulator/+page.svelte:431-444` | Dev-only page — low priority | Add `min-h-[44px]` if operator tests on phone |

---

## Polish recommendations

1. **Remove subtraction debt in `WorkSurfaceCard.svelte`** — delete unused imports (`PhaseChecklist`, `WorkerRegistry`, `ProofCard` at lines 5-7), dead `suppressInlinePanels` prop (15-22, never read in template), and orphaned CSS (~365-486). Biggest clarity win for zero visual change.

2. **Fix expanded vs compact action mismatch** — compact shows Stop for all `isInMotion` states (`WorkSurfaceCard.svelte:154-157`); expanded only renders actions when `task.state === 'Waiting' \|\| task.state === 'Working'` (`210-226`) and Stop only when `Working`. Operator in `Reading`/`Reviewing`/`Delivering` loses Stop in expanded footprint. Align expanded guard with `isInMotion` / `displayStopButton`.

3. **Extract shared `workerBrandColor()`** — dedupe `WorkerRow.svelte:20-30` and `WorkGraph.svelte:148-157` into `$lib/workSurface/workerColors.ts` backed by `@theme` tokens. Prevents the CC/AGY palette drifting between waveform and graph.

4. **Re-home Build highlights off `--color-brand`** in `WorkerRegistry.svelte` — use per-worker or role semantic colours already locked in graph/row components.

5. **Replace `text-[--color-*]` arbitrary properties** in `WorkSurfaceDock.svelte` with proper utilities (`text-st-run`, etc.) for Tailwind 4 consistency.

6. **Remove dead `getNodePos`** from `WorkGraph.svelte:159-162`.

7. **Add approve-timeout cleanup** on card destroy (`WorkSurfaceCard.svelte:29`).

8. **Tighten types** — drop `WorkerRow` string widening; resolve `Idle` cast in `WorkGraph.svelte:269`.

9. **Verify or delete `shadow-status-*` / `shadow-brand`** in `WorkerRegistry.svelte` — confirm in built CSS; if absent, remove (subtraction).

10. **Update stale indicator comment** (`WorkSurfaceIndicator.svelte:7-8`) from "muted-rose" to "st-run blue".

---

## Stay-as-is

- **Doctrine implementation** — badge absent when idle (`WorkSurfaceDock.svelte:84`, `WorkSurfaceIndicator.svelte:101`); accordions default collapsed (`WorkSurfaceDock.svelte:15`); actions absent when unavailable; one flat worker row per worker (`WorkerRow.svelte:43-89`).
- **`SurfaceProgressRing` celebration + earned-rest handoff** — textbook `$effect` + plain `prevState` pattern (`SurfaceProgressRing.svelte:38-61`).
- **`WorkGraph` mobile 3-signal active-node fallback** — drop-shadow + ring + circle stroke (`533-546`); do not remove redundancy.
- **`WorkGraph` idle quiet** — `.work-graph.idle { opacity: 0.4; animation: none }` (`607-612`) correctly silences motion when settled.
- **`StageTimeline` segmented track** — state-gated marching connector (`27,159-165`); REPLY filtered intentionally.
- **`surfaces.svelte.ts` module pattern** — function getters + consumer `$derived()` wrapping is idiomatic Svelte 5.
- **`workSurface.ts` contract** — well-documented projection layer; keep as seam between FSM and UI.
- **Flow simulator** — good doctrine verification harness; trajectory log shape is useful for QLoRA corpus work.
- **Square packet shape** — out of scope per prompt; icon-sprite wire-in is separate work.

---

## Stamp

**SHIP-WITH-POLISH**

Small, surgical fixes (subtraction pass + action-row parity + token dedupe) will clear the remaining gaps without touching locked design.
