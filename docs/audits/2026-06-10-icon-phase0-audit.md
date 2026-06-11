# Icon System — Phase 0 Audit & Diagnosis (LOS-190 lane)

**Date:** 2026-06-10 · **Auditor:** CC (interactive, operator-gated) · **Method:** 11-agent fan-out (7 cluster auditors → completeness critic → 2 adversarial verifiers), 361 icon sites recorded, 13/14 sampled claims fully accurate, 13/14 verdicts canon-consistent (corrections applied).
**Full reviewable inventory + approve/reject gallery:** `https://room.taila28611.ts.net:8465/` (tailnet) — service `logueos-icon-gallery.service`, tooling at `~/dev/icon-gallery/` (outside this repo by design).
**Canon:** `docs/design/sully-locked-spec.md` (Indigo, locked 2026-06-10).

---

## The operator's question: why does the surface still look old despite the new palette?

**361 sites audited. 150 are the right glyph in the wrong color. Only 48 use token variables.**

### Cause 1 — Icons never moved onto the tokens (primary)

- **Stock Tailwind classes everywhere:** zinc grays on chrome, cyan for image-mode/drag-drop (Composer), emerald for talkback, orange for ALL of VoiceMode, stock reds. None are mapped to the Indigo ramp in `@theme`, so they render exactly the pre-rebrand colors.
- **The `@theme` "semantic" mappings that DO exist are stale:** `--color-status-green/amber/red/blue` → `#22c55e/#f59e0b/#ef4444/#3b82f6` (stock TW-500s), NOT canon `--green #4ade80 / --amber #fbbf24 / --red #f87171 / --blue #60a5fa`. The work-surface `st-*` dot ramp (`#d4d4d8/#c9a34e/#71717a/#c25b5b`) and `--color-muted-foreground #a1a1aa` likewise predate the lock. Even color-disciplined code renders off-canon.
- **One `@theme` repoint pass + a stock-class sweep clears most of the 150 RETINTs.**

### Cause 2 — The brand ghost is still magenta where it matters most

- `SullyAvatar.svelte:45` orb glow bakes `rgba(255,77,148,.5)` (#ff4d94); ChatHeader sully-mark drop-shadow bakes `rgba(236,45,120,.5)` (#ec2d78).
- **The entire home-screen set is the magenta mark:** favicon.png, apple-touch-icon.png, icon-512/maskable/1024 and all 12 `static/ios/splash-*.png` (histogram-verified #F127A6/#AE0567/#FD8EDC family, generated May 31 — pre-lock). Source PNG for `scripts/gen-app-icons.sh` (`static/Sully_icon.PNG`) is itself magenta — an Indigo source mark is the real deliverable.
- `manifest.webmanifest` + `app.html` theme-color is `#0d1117` (stale GitHub-dark ≠ `--bg0 #0b0c10`) — tints the iOS status bar off-token at every launch.

### Cause 3 — Mixed glyph families (but not the suspected pair)

- `@iconscout/unicons`: **zero imports** (dead dependency, package.json:71). `Icon.svelte`: **zero consumers** (dead wrapper, stroke 1.5, name prop unused). Neither ever renders — misleading, but invisible.
- The real mix: **lucide** (89 sites, stroke 2 core / 2.25 dispatch-stage) + **38 hand-rolled SVGs** (stroke 2/2.25/2.5, incl. a hand-pasted copy of lucide X at `WorkSurfaceDock.svelte:230`) + **25 emoji-as-chrome** (Composer talkback labels, Markdown copy buttons). Emoji can't tint with currentColor, render OS-styled, off-grid.

### Bright spot

`WorkerPill` — the only work-surface component live in the production chat feed — is **fully canon** (pillModel → stage dots bound to `--ui/--live/--red/--amber`). Worker brand sprites are currentColor (except Cursor's baked multi-hex mark). Live accent budget is clean (only WorkerPill's active dot). The "doesn't blend" feeling is the chrome around the good parts.

---

## Verdict counts (361 sites → 279 consolidated assets)

| Verdict | Sites | Meaning                                             |
| ------- | ----- | --------------------------------------------------- |
| RETINT  | 150   | right glyph, wrong color — token wiring only        |
| KEEP    | 134   | already correct (or operator-locked identity marks) |
| REMOVE  | 48    | dead code / duplicates                              |
| REPLACE | 29    | wrong family/style or broken asset                  |

Color modes: 65 baked-hex, 76 stock-tailwind-class, 92 currentColor (helps only when the parent is tokened), 48 token-var, 58 none, 22 mixed.

## Dead-weight kill list (REMOVE, pending operator approval at CP1)

- `Icon.svelte` + `@iconscout/unicons` dep (both dead)
- `DispatchChips.svelte` (zero consumers, pure retired-magenta), `PhaseChecklist.svelte`, `SurfaceProgressRing.svelte` (zero consumers)
- `/chat/preview` route (stale SDK sandbox, self-documented as delete-after-copy)
- `src/lib/assets/favicon.svg` (stock Svelte logo, unreferenced), `static/los_logo.png` (1MB unreferenced), `static/facelift/*.html` (archived mockups publicly served)
- Duplicate reference assets: `review_queue/svg/` is a byte-identical snapshot of `svg_assets/` (15 dupes incl. a colored/mono antigravity filename collision); 2 of 3 `ai-company-logo*.json` Lotties are variants of the same comp

## Load-bearing constraints any sweep MUST honor

1. **⚠️/💬/🔍/🔨/🧪 emoji prefixes on system messages are a de-facto protocol**: `hermes.ts:150-154` and `gemini.ts:177-183` strip rows from LLM history via `startsWith` on these glyphs. Changing message-copy glyphs silently changes context assembly — out of scope for the icon pass.
2. **Markdown.svelte glyphs** (📋 ⌧ ✓) are raw HTML strings inside the `marked` renderer override, state-swapped via textContent — lucide components can't drop in; needs inline SVG strings + DOMPurify `ALLOWED_TAGS` additions.
3. **Worker identity tints are operator-locked (2026-06-06)**: CC #f97316, AGY #a855f7, CDX #9ca3af, DPSK #3b82f6, GMI #60a5fa, CUR #a8a29e. DPSK/GMI textually collide with banned hexes but are identity tints — keep hues, lift to `--worker-*` tokens. The retint targets are the FALLBACKS (`var(--color-status-blue)` → #3b82f6; `#8a8a8a` in HybridSurfaceMount).
4. **`WORKER_TEMPLATES` identity-over-role precedence** (chatBridge.svelte.ts) guards the 2026-06-07 CC-rendered-as-AGY incident — preserve in any map consolidation.
5. **elapsedDisplay glyph-in-data**: `surfaceAdapter.ts:370-377` bakes `✓ /✕ /■ ` into strings; HybridDispatchPill renders verbatim, HybridDispatchCard strips via regex. Antipattern, but coordinated change only.

## Structural debt found (consolidation targets for CP2)

- `STAGE_ICONS` map duplicated verbatim in StageActIcon.svelte + StageTimeline.svelte
- Worker icon-name maps near-duplicated in WorkGraph.defaultIconForRole + DispatchCard.getWorkerIconName (+ seeds)
- `workerBrandColor` hexes duplicated in workerVisual.ts + sandbox-seed.ts fixtures
- WorkerIconSprite mounted in 3 places → duplicate symbol ids in DOM
- Role-fallback puts BRAND marks on non-brand workers (system-verify node renders the Codex logo)
- Idle workers tinted `--color-status-amber` in WorkGraph (semantic violation; idle should be a gray)
- WorkingBubble.svelte is entirely pre-Indigo (fuchsia/emerald/rose) with a stale 2-worker who-map

## Open operator decisions (gated at CP1 in the gallery)

1. **Dispatch-layer accent:** adopt `--live` per locked spec (recommended) vs keep pre-lock "neutral beam" doctrine (zinc + worker brands, zero accent).
2. **Worker tints to `--worker-*` tokens** (same values) — recommended.
3. **Kill-list approval** (above).
4. **Indigo home-screen source mark** — candidates to be brought to CP4/CP5.

## Plan (each checkpoint operator-gated in the gallery)

- **CP2** — one line family (lucide, stroke 2) + retint sweep: kill approved dead weight, repoint stale `@theme`, sweep stock classes onto tokens, kill magenta glows, consolidate duplicated maps, lift brand tints to tokens.
- **CP3** — UI/nav/file/control gaps: existing assets (4 inbox system icons are already canon: task/packet/dispatch/blocked) → lucide → sourced.
- **CP4** — worker brand marks: mono Cursor variant, fill=currentColor for gemini/ollama svgs, marks for ki/glm, kill brand-on-role fallback.
- **CP5** — working-state animations, in-token, with variants (dispatched/queued, active, verifying, done, failed, waiting-input). Inbox Lotties = motion reference only.
- **CP6** — wire approved assets + app icon/splash regeneration + STANDARD VERIFY + PR. Nothing touches the live app before this.
