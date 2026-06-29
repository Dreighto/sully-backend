# AGY Build Spec — Work Surface → Svelte 5 Component (LogueOS-Companion)

## 0. Mission (read this first, then re-read the CRITICAL constraints in §11)

Lift the polished Work Surface mock into a real, reactive Svelte 5 component in the Companion app. The component takes a `task: WorkSurfaceTask` prop, faithfully reproduces the mock (node graph + magenta/amber/red/green settle states + the 6-stage spine + the 3 footprints + the unified Lucide/worker icon families), uses the app's brand utility classes (NOT raw hex), renders from SEED data first, and ships with a standalone preview route with a preset + footprint switcher for browser verification.

**Source of truth = the mock files (do NOT improvise motion):**
- JS engine + PRESETS: `/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.js`
- CSS (keyframes/colors/tiers): `.../real_assets_v4_final.css`
- HTML (SVG `<symbol>` sprite + 3-footprint DOM): `.../real_assets_v4_final.html`
- Design intent: `.../README.md`

**Verified environment facts (already checked — do NOT re-verify):**
- `node_modules` PRESENT, `lucide-svelte` PRESENT. No `npm install`.
- Dev server: `npm run dev` → `0.0.0.0:18769`, base path `/companion`. App lives at `http://localhost:18769/companion`.
- Runes are FORCED on for all non-`node_modules` files (`svelte.config.js` compilerOptions.runes). Legacy `$:`/stores are NOT available.
- Brand tokens confirmed in `src/app.css` `@theme` block (see §6 table — every hex below is real).

---

## 1. Component decomposition

One smart container + several dumb presentational sub-components. All flat in `src/lib/components/` (the lib has zero subdirs — keep the convention).

| Component | Responsibility | State? |
|---|---|---|
| `WorkSurfaceCard.svelte` | **Smart container.** Owns `task` prop, footprint `$state`, confirm-flow `$state`, intensity/monochrome `$state`. Computes graph layout `$derived`. Wires the `state-${footprint}` / `status-${...}` root classes. Renders the 3 footprint sub-views. Emits `onapprove` / `onstop` / `onretry` / `onexpand` callbacks. | yes |
| `WorkGraph.svelte` | **The SVG node graph**, rendered declaratively from props (`routes`, `workerNodes`, `systemNodes`, `coreStatus`, `motionType`). Used TWICE (compact + expanded). No internal state. | no |
| `WorkSurfaceSprite.svelte` | The hidden global `<svg><defs>` sprite (all `<symbol>` worker icons + 3 payloads). Mounted ONCE (see §3 risk). | no |
| `StageTimeline.svelte` | The 6-pill horizontal spine (`Read→Research→Build→Check→Approve→Reply`). `{#each task.stageProgress}`. | no |
| `WorkerRegistry.svelte` | Expanded-only worker grid (role + identity + step + lastFile). Uses worker icons + Lucide. | no |
| `ProofCard.svelte` | Expanded-only QA card (verdict + score + `checks[]`). Lucide check/x icons. | no |
| `PhaseChecklist.svelte` | Expanded-only routing-phases checklist (done/active/pending + times). | no |
| `WorkSurfaceActions.svelte` | The action button row (Approve / Stop / Retry / Expand-Close), with the double-tap confirm UI. Brand pill buttons. | small (confirm passthrough or owned by card — owned by card, this is dumb) |

**Collapsed pill** is small enough to live inline in `WorkSurfaceCard` (mock: just pulse + title + meta). Don't over-decompose it.

---

## 2. Exact file list (create / edit)

**CREATE — types**
- `/home/dreighto/dev/LogueOS-Companion/src/lib/types/workSurface.ts` — the contract type file (full contents supplied in `typesTs` output; write VERBATIM).

**CREATE — seed data**
- `/home/dreighto/dev/LogueOS-Companion/src/lib/data/workSurfaceSeed.ts` — exported `WorkSurfaceTask[]` (or keyed record) mirroring the 10 mock presets, typed against `workSurface.ts`. (Create the `src/lib/data/` dir — it doesn't exist yet; that's fine, flat one-level is acceptable for data fixtures and keeps fixtures out of the component dir. If AGY prefers zero new dirs, place at `src/lib/workSurfaceSeed.ts` — either is acceptable; `src/lib/data/` preferred.)

**CREATE — components** (all in `/home/dreighto/dev/LogueOS-Companion/src/lib/components/`)
- `WorkSurfaceCard.svelte`
- `WorkGraph.svelte`
- `WorkSurfaceSprite.svelte`
- `StageTimeline.svelte`
- `WorkerRegistry.svelte`
- `ProofCard.svelte`
- `PhaseChecklist.svelte`
- `WorkSurfaceActions.svelte`

**CREATE — preview route**
- `/home/dreighto/dev/LogueOS-Companion/src/routes/work-surface-preview/+page.svelte` (single `+page.svelte`, no `+page.ts` — matches `avatar-preview` precedent).

**NO EDITS to existing app files are required.** Do NOT touch `app.css`, `+layout.svelte`, `hooks.server.ts`, or any `$lib/server/*`. (The mock's `--sully-text-muted` typo is fixed locally in the component `<style>`, not in the global stylesheet — see §6.)

---

## 3. Porting strategy — SVG graph engine

The brief's "hard SVG math" fear is **mostly unfounded** (per engine analysis). De-risk by splitting clearly:

### 3a. Layout (EASY — port the lookup table verbatim)
- `getWorkerPositions(count)` (js:280) is a **hardcoded position table**, not trig. Port as a pure function. ViewBox is `0 0 340 130`. TASK core fixed at `{x:170, y:65}`. Count→slots: 1→`{60,65}`; 2→`{60,35}/{60,95}`; 3→2-left+1-right; 4→2×2 at x=60/280; 5+→3-left+2-right.
- **System helper nodes** (js:393, ONLY when count===1): researching presets inject `system-memory` at `{280,65}` + a dashed off-canvas input edge from `{340,105}`; verifying presets inject `system-verify` at `{280,65}`. Port these conditionals into the layout `$derived`.

### 3b. Edge paths (EASY — pure function)
- `pathD(sx,sy,ex,ey)` (js:442): if `sy===ey` → `M sx sy L ex ey`; else quadratic Bézier `M sx sy Q ctrlX ctrlY ex ey` with `ctrlX=(sx+ex)/2`, `ctrlY` bowed 10px AWAY from the target (up if start above center, down if below).
- **This one string is reused 4 ways** (backing lane, base edge, sweep overlay, AND each packet's `offset-path`). Compute it ONCE per route in the `$derived` `routes` array; the SVG template just reads `route.pathD`. **This is the single most important structural rule** — never recompute the path string in two places or the packet glide desyncs from the lane.

### 3c. Primary vs secondary emphasis (JS-assigns-class, CSS-enforces)
- `isPrimary = (count===1) || (worker.motionType === task's activeMotionType)`. Map `task` → an `activeMotionType` (derive from `task.state`/`task.stage`; see §5 seed mapping). Primary route gets backing+sweep+3 packets (research/build) or 1 (verify); secondary gets class `secondary-active` and CSS dims it. **Do NOT compute styling in JS** — assign the class, let the ported CSS do the dimming.

### 3d. Rewrite imperative → declarative (MANDATORY)
The mock builds the graph with `svg.innerHTML=''` + `createElementNS` (js). **Do NOT port that.** Rewrite as Svelte markup inside one `<svg viewBox="0 0 340 130">` in `WorkGraph.svelte`:
```
{#each ringRadii as r}<circle class="core-field" {r} cx="170" cy="65" .../>{/each}
{#each routes as route (route.id)}
  {#if route.isPrimary && !route.isEdge}<path class="edge-line-backing" d={route.pathD}/>{/if}
  <path class="edge-line {route.isPrimary ? '' : 'secondary-active'} {route.isEdge ? 'edge-input' : ''}" d={route.pathD}/>
  {#if route.isPrimary && route.hasSweep}<path class="edge-sweep-line" d={route.pathD}/>{/if}
  {#each route.packets as p, i (i)}
    <g class="node-icon-wrapper">
      <use href="#payload-{route.motionType}"
           style:offset-path={`path("${route.pathD}")`}
           style:animation-delay={p.delay} />
    </g>
  {/each}
{/each}
{#each workerNodes as w (w.id)} ...orbital ring r23, node-circle r17, <use href="#{w.icon}"> 22px, key label... {/each}
{#each systemNodes as n (n.id)} ...same structure... {/each}
<g class="central-task">core-pulse r14, ripple r20, central-task-node r20 (class status-*), <use href="#icon-task">, "TASK" label</g>
```
- **Draw order matters for z-stacking** — replicate exactly: (1) core-field rings → (2) routes → (3) worker nodes → (4) system nodes → (5) central TASK group.
- Render `<WorkGraph .../>` twice (compact + expanded). It's a pure prop-driven component, so two instances is free.

### 3e. The sprite (`WorkSurfaceSprite.svelte`) — see §10 RISK
- Worker icons (`<symbol>` family — KEEP these, do not Lucide-ify): `icon-claude`, `icon-antigravity`, `icon-gmi`, `icon-cdx`, `icon-deepseek`, plus the 3 payloads `payload-researching`/`payload-building`/`payload-verifying` and `icon-packet` (nested `<use>` inside payloads), and `icon-task`.
- Mount the sprite ONCE per card instance at the top of `WorkSurfaceCard` markup. `<use href="#id">` fragment refs resolve to the same document — fine within one rendered card. (Do NOT put it in `+layout`; keeping it inside the card keeps the component self-contained and avoids the base-path/layout coupling. The two `<WorkGraph>` instances in one card share the one sprite instance via in-document `#id` refs.)

---

## 4. Porting strategy — animations & CSS

The mock CSS is ~70% animation and is **load-bearing and hand-tuned**. Port it nearly verbatim into a co-located `<style>` block (scoped) in `WorkGraph.svelte` for graph anims, and `WorkSurfaceCard.svelte` for footprint/settle anims. Split by which component owns the animated DOM.

**Port verbatim, do NOT "clean up":**
- All 20+ keyframes: `coreFieldBreath`, `wakeFieldSweep`, `wakeTaskCore`, `glidePacketResearching/Building/Verifying`, `breath*`, `radarBlipPulse`, `sweepMotion`, `coreBreath`, `rippleAnim`, `rippleBuildingArrival` (the 50/61.4/72.8% collision sync), `rippleVerifyingArrival`, `rotateOrbital`, `floatNode`, `ringConverge`, `amberDampen`, `redNudge`, `oneShotPayload`, `softSweepGlow/Pass`, `dotBreath`, `dangerPulse`.
- **The magic timing numbers stay** — packet `animation-delay` (`i*2.5s` researching, `i*0.4s` building) MUST stay aligned with the ripple keyframe percentages (50/61.4/72.8%). This synchronized-collision effect IS the feature. Set delays via `style:animation-delay` from the derived packet specs; do NOT round or "simplify."
- `transform-box: fill-box` on `central-task-node` (SVG transform-origin centering) — preserve or breaths scale from the wrong origin.

**Settle states (the 4 colors) — keep the single-switch architecture:**
- Card root class `status-${task.state-lowercased}` is the ONE switch. Magenta=working/checking (brand), amber=waiting/stopped, red=blocked/failed, green=complete.
- Complete/stopped/failed rely on `display:none !important` cascades scoped under `.status-complete/.status-stopped/.status-failed`. **Keep the animated elements PRESENT-but-hidden** — do NOT conditionally render them out. The CSS expects them in the DOM.

**Intensity tiers:** port `.intensity-subtle|normal|debug` but apply to the **component root**, not `<body>`. Default `normal`.

**`prefers-reduced-motion`:** port the media-query block VERBATIM (css:45) — it crushes all durations/iterations to `0.01ms` and shows a reduced-motion notice. It's free (a media query). This satisfies the reduced-motion requirement. Scope it inside the component `<style>`.

**Footprint transitions:** keep the CSS `max-height`/`opacity`/`pointer-events`/`padding` transitions driven by `state-collapsed|compact|expanded` on the root. Default footprint = `compact`.
- collapsed: only `.sully-collapsed-view` visible, `border-radius:24px`, `width:max-content`.
- compact: header+timeline+graph+ownership+banner+actions, `max-height:420px`.
- expanded: full detail (2nd graph, phases, worker registry, proof, footer), `max-height:850px`.

**Wake-ping replay (RISK — see §10):** the mock uses the forced-reflow hack `el.classList.remove('wake-active'); void el.offsetWidth; el.classList.add('wake-active')`. **Do NOT port this** — it fights runes. Use a `{#key footprint}` wrapper around the graph/header subtree so a footprint change remounts and replays the wake animation declaratively.

---

## 5. Svelte 5 runes approach + brand-token mapping + seed data

### 5a. Runes (match the app idiom — confirmed from `avatar-preview/+page.svelte`)
- **Props:** destructure once from `$props()` with an inline type literal (NOT a separate interface). Callbacks are `onfoo` props (lowercase), NOT `createEventDispatcher`.
  ```ts
  let { task, intensity = 'normal', onapprove, onstop, onretry, onexpand }: {
    task: WorkSurfaceTask;
    intensity?: 'subtle' | 'normal' | 'debug';
    onapprove?: () => void;
    onstop?: () => void;
    onretry?: () => void;
    onexpand?: (footprint: 'collapsed' | 'compact' | 'expanded') => void;
  } = $props();
  ```
- **State:** `let footprint = $state<'collapsed'|'compact'|'expanded'>('compact');` `let confirmApprove = $state(false);` `let confirmStop = $state(false);` `let monochrome = $state(false);`
- **Derived:** `const activeMotionType = $derived(...)`; `const workerNodes = $derived(...)`; `const layout = $derived(getWorkerPositions(workerNodes.length))`; `const routes = $derived.by(() => ...build route objects with pathD/isPrimary/packets...)`; `const cardClass = $derived(\`work-surface-card state-${footprint} status-${task.state.toLowerCase()} intensity-${intensity}${monochrome ? ' monochrome-graph' : ''}\`)`.
- **Keep `$derived` pure.** No side-effects. The route-building is a pure function of `task`.
- **`{#each}` always keyed.** `{#each task.workers as w (w.identity)}`, `{#each routes as r (r.id)}`.
- **`$effect`** only if you need a setTimeout for the approve-sweep (1200ms) before firing `onapprove`. Return the cleanup. Use `clearTimeout` in cleanup.

### 5b. Mapping `WorkSurfaceTask` → mock view-model
The mock presets are richer than the contract in a couple of spots. Bridge in pure derived helpers inside `WorkSurfaceCard`:
- `activeMotionType`: derive from `task.stage`/`task.state` → `Research`→researching(cyan), `Build`→building(blue), `Check`→verifying(purple), `Waiting`→waiting(amber), `Complete`→complete(green), `Failed`→failed(red), `Stopped`→stopped(amber). (Mock uses lowercase motion strings; map accordingly.)
- per-worker `motionType`: derive from `worker.role` + `worker.status` (Research→researching, Build→building, Review→verifying; status done/idle → complete/waiting).
- `bannerText`: the mock embeds raw `<span class='banner-highlight'>` HTML. **Do NOT use `{@html}`.** Restructure: in seed data, model the banner as `{ text, highlight }` or just plain text + a separate brand-colored `<span>` in markup. (The contract has no banner field — synthesize banner text from `task.state` + worker, or add a derived `bannerText` string; keep it plain-text, no HTML injection.)

### 5c. Brand-token mapping (USE THE UTILITY CLASS — never the hex)
Tailwind 4 generates utilities from `@theme` in `app.css`. Confirmed tokens:

| Mock intent | Token (app.css) | Hex | Type THIS |
|---|---|---|---|
| Primary magenta ("alive"/Sully) | `--color-brand` | `#ec2d78` | `bg-brand` `text-brand` `border-brand` `ring-brand` (+ opacity: `bg-brand/10`, `border-brand/30`) |
| Bright/hover magenta | `--color-brand-bright` | `#ff4d94` | `text-brand-bright` `bg-brand-bright` |
| Deep magenta (gradient base) | `--color-brand-deep` | `#c4186a` | `to-brand-deep` `bg-brand-deep` |
| Soft magenta (labels on dark) | `--color-brand-soft` | `#ff7eb3` | `text-brand-soft` |
| Glow magenta (ambient) | `--color-brand-glow` | `#ff8fc0` | `text-brand-glow` |
| App background | `--color-background` | `#050505` | `bg-background` |
| Card/surface | `--color-surface`/`--color-card` | `#111111` | `bg-surface` `bg-card` |
| Primary text | `--color-foreground` | `#ffffff` | `text-foreground` |
| Muted text | `--color-muted-foreground` | `#8b949e` | `text-muted-foreground` |
| Borders | `--color-border` | `#27272a` | `border-border` |
| Status green/amber/red/blue/purple | `--color-status-*` | (see app.css) | `text-status-green` `bg-status-amber` `text-status-red` `text-status-blue` `text-status-purple` |
| Worker accents | `--color-worker-claude/-gemini/-operator` | `#8b5cf6`/`#3b82f6`/`#ef4444` | `text-worker-claude` etc. |

**Settle-color rule:** the SVG settle colors (magenta/amber/red/green) live INSIDE the ported `<style>` keyframes/route rules and may reference `var(--color-brand)`, `var(--color-status-amber)`, `var(--color-status-red)`, `var(--color-status-green)` directly (CSS vars exist globally). The Tailwind UTILITY classes are for the CHROME (card border, header, buttons, labels, pills) — use utilities there. **Do not use raw `zinc-*`/`fuchsia-*` for brand chrome** — the operator spots off-brand instantly. Reserve neutral `zinc-*` only for genuinely neutral chrome; prefer `bg-surface`/`border-border`.

Per-motion ACCENT colors (separate from settle): researching=cyan `#0ea5e9`, building=blue `#3b82f6`, verifying=purple `#8b5cf6`. These color in-flight packets/sweeps and live in the `<style>` as literals or mapped vars — port from the mock as-is.

### 5d. Seed data plan (`workSurfaceSeed.ts`)
Ship the 10 mock presets as typed `WorkSurfaceTask` objects (key by id for the switcher): `cc-researching`, `agy-building`, `dpsk-verifying`, `gmi-brainstorming`, `cdx-reviewing`, `multi-worker`, `waiting-approval`, `complete`, `stopped`, `failed`.
- Map each preset's fields onto the contract: `state`/`stage`/`stageProgress`/`workers`/`routing`/`proof`/`result`/`block`/`isDestructive`. `waiting-approval` sets `isDestructive: true` + `block: { kind: 'approval', targetPath: ... }`.
- `stageProgress` is always the 6-stage spine; use `skipped` where a stage didn't occur (e.g. Research when no research worker).
- `routing.nodes`: one `core` (Sully) + one per worker. `routing.edges`: active where the worker is mid-flight.
- Worker identities map to the icon family: claude-code→`icon-claude`, antigravity/AGY→`icon-antigravity`, gemini/GMI→`icon-gmi`, cdx→`icon-cdx`, deepseek→`icon-deepseek`.
- Export `export const workSurfaceSeed: Record<string, WorkSurfaceTask> = {...}` and `export const seedKeys = Object.keys(workSurfaceSeed)`.

---

## 6. The `--sully-text-muted` typo (do NOT propagate)
The mock CSS line 13 is malformed: `var(--sully-text-muted): #64748b;` (should be `--sully-text-muted: #64748b;`). When porting any rule that uses `var(--sully-text-muted)`, **map it to the app token** `var(--color-muted-foreground)` (#8b949e) or the `text-muted-foreground` utility instead. Do NOT re-introduce the broken `--sully-*` palette — translate the mock's `--sully-brand-magenta`→`--color-brand`, `--color-waiting`→`--color-status-amber`, `--color-blocked`→`--color-status-red`, `--color-complete`→`--color-status-green` as you port. This kills two birds: fixes the bug AND aligns to brand tokens.

---

## 7. The preview route (browser-verifiable)
See `previewRoutePlan` output for the exact path + approach. It mounts `<WorkSurfaceCard>` with seed data and provides a preset switcher (10 buttons) + footprint switcher (collapsed/compact/expanded) + intensity + monochrome toggles. Reach at `http://localhost:18769/companion/work-surface-preview`.

---

## 8. Icons — keep BOTH families
- **Worker icon family = SVG `<symbol>` sprite (KEEP, do not replace):** `icon-claude`, `icon-antigravity`, `icon-gmi`, `icon-cdx`, `icon-deepseek`, payloads `payload-researching/building/verifying`, `icon-packet`, `icon-task`. These are bespoke and identity-load-bearing.
- **Non-worker icons = Lucide (`lucide-svelte`):** use Lucide for chrome/semantic icons — the mock's `icon-approval`/`icon-blocked`/`icon-complete`/`icon-failed`/`icon-waiting`/`icon-stopped`/`icon-dispatch`/`icon-research`/`icon-build`/`icon-verify`/`icon-memory`/`icon-brainstorm`/`icon-coordinated`/`icon-signal`/`icon-wifi`/`icon-battery` map to Lucide equivalents (e.g. `CheckCircle2`, `Ban`, `Clock`, `CircleCheck`, `CircleX`, `Search`, `Hammer`, `ShieldCheck`, `BrainCog`, `Lightbulb`, `Users`, `Signal`, `Wifi`, `BatteryFull`, `Send`). Import per-icon: `import { CheckCircle2, Ban, Clock } from 'lucide-svelte'`, size via `size={14}`, `aria-hidden="true"`. **Unify the non-worker icons under Lucide** for a coherent app look; keep the worker symbols as the distinctive identity layer.

---

## 9. Verification (mandatory before declaring done)
1. `npm run dev` → open `http://localhost:18769/companion/work-surface-preview`. Cycle ALL 10 presets × 3 footprints. Confirm: graph renders, packets glide the lanes, settle colors correct (magenta/amber/red/green), 6-stage spine renders, sprite `<use>` icons resolve (NOT empty boxes), worker icons present.
2. `npm run check` (svelte-check) — zero errors.
3. `npm run format` (prettier) — let it sort Tailwind classes.
4. Browser-load QA on the iPhone viewport is MANDATORY per operator rule — use the `companion-deploy-verify` skill loop. Specifically smoke-test `offset-path` packet motion on **iOS WebKit** (the operator's phone target) — this is the #1 risk (see §10.1).

---

## 10. RISK FLAGS + de-risking

1. **`offset-path: path("...")` on iOS WebKit (HIGHEST RISK).** Packet glide uses CSS `offset-path` + `offset-distance` animation set inline. Safari/iOS has historic Houdini quirks. *De-risk:* (a) compute the path string in `$derived` so it tracks layout changes; (b) **browser-verify on iOS WebKit FIRST** via the mobile-test stack (`test:e2e:webkit` project / iPhone viewport) before building everything else — if packets don't move on WebKit, fall back to a rAF JS tween or SMIL `<animateMotion>` (which the same `pathD` string feeds directly). Flag this to the operator if WebKit fails; don't silently ship a static graph.
2. **Forced-reflow animation replay does NOT map to runes.** *De-risk:* use `{#key footprint}` to remount the wake subtree. Never port `void el.offsetWidth`.
3. **`<use href="#...">` fragment refs + SvelteKit base path (`/companion`) + Vite ID scoping.** Fragment refs are document-relative (NOT URL-relative) so `/companion` base shouldn't break them, BUT Vite/Svelte can scope/rewrite IDs. *De-risk:* keep the sprite as plain `<symbol id="...">` inside `WorkSurfaceSprite.svelte` markup (NOT scoped CSS, IDs are global), mount once per card, and **test that `<use>` resolves AFTER a production `npm run build`/`preview`, not just dev.** Nested `<use>` (payloads referencing `#icon-packet`) is the fragile bit — verify payloads render filled, not hollow.
4. **SVG coordinate math (LOW risk, contrary to brief).** Layout is a lookup table; path is a one-line Bézier. The ONLY real geometry risk is keeping `offset-path` strings in sync when worker count changes — solved by computing `pathD` once per route in the `$derived` and reading it everywhere.
5. **`transform-box: fill-box` origin.** Breaths/ripples scale from wrong origin if dropped. Preserve on `central-task-node` and any scaled SVG element.
6. **Settle `display:none !important` cascades.** Keep animated elements present-but-hidden under `.status-*`; don't conditionally render them out.
7. **Magic timing numbers (packet delays ↔ ripple % 50/61.4/72.8).** Don't normalize. They're the synchronized-collision feature.
8. **`bannerText` raw HTML / `alert()`.** No `{@html}` (XSS) — restructure to plain text + brand `<span>`. Replace `alert()` with the app toast utility or just inline confirm UI (the double-tap confirm needs no alert).
9. **Scope new dirs minimally.** `src/lib/data/` is the only new dir; everything else slots into existing flat dirs.

---

## 11. CRITICAL constraints (bookend)
- **Svelte 5 runes only.** `$state`/`$derived`/`$props`/`$effect`. No `$:`, no stores, no `createEventDispatcher`. Callbacks = `onfoo` props.
- **Brand utility classes, NOT raw hex**, for all chrome. Settle colors inside `<style>` reference `var(--color-*)`. Translate mock's `--sully-*`/`--color-waiting/blocked/complete` to the app tokens as you port.
- **SEED-data first.** Component renders entirely from `workSurfaceSeed.ts`; no backend, no fetch.
- **Faithful reproduction** of the mock: node graph, 4 settle states, 6-stage spine, 3 footprints, unified Lucide + worker-symbol icon families.
- **Standalone preview route** with preset + footprint switcher, browser-verifiable at `http://localhost:18769/companion/work-surface-preview`.
- **No edits to existing app files.** No `$lib/server/*` imports into client code (hard rule).
- **End on `main`, clean tree.** Run `npm run check` + `npm run format` + iPhone-viewport browser QA before declaring done.