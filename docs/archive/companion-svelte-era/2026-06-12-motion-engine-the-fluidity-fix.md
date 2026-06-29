# Motion Engine — the fluidity fix (sheets, drawers, scroll)

> **Why this exists:** the operator tested Phase B and the motion is NOT flagship-fluid:
> (1) swiping the model picker "immediately closes" instead of tracking the finger; (2) the
> sidebar closes too fast and **flickers**; (3) scroll smoothness isn't verified. The operator
> was explicit: _"if we can't get animations smooth and fluid like the flagship targets, this
> app is not flagship ready by a mile."_ This doc is the deep root-cause + the canonical fix,
> web-grounded (vaul / UIKit / WebKit research, citations at end).
>
> **Author:** CC (VP Ops, deep-research pass) · **For:** the motion owner (CUR) · **2026-06-12**
> **Authority:** complements the hybrid canon's Part 3/4 motion system. This SUPERSEDES the
> CSS-`@keyframes`-for-open/close approach used in Phase B (`mpc-closing`, `ts-sidebar-out`).

---

## The one root cause behind all three problems

**Phase B animates open/close with CSS `@keyframes` + a `closing` boolean + a `setTimeout`-deferred
unmount.** That architecture _cannot_ be fluid, for three structural reasons the research is
emphatic about:

1. **A keyframe can't continue from where your finger left off.** When you drag the sheet to
   `translateY(180px)` and release, the close keyframe restarts from `translateY(0)` — so the sheet
   visibly **snaps back up, then plays a from-scratch slide**. That snap is what the operator feels
   as "it just immediately closes." (Confirmed in `sheetDrag.svelte.ts`: `externalExit:true` clears
   the inline drag transform — `sheet.style.transform = ''` — before handing off to the `mpc-closing`
   keyframe.)
2. **A keyframe can't carry release velocity.** A slow drag and a fast flick produce identical motion
   — "dead," not physical.
3. **`@keyframes` + `forwards` fill + removing the class on a state flip = a 1-frame WebKit flicker.**
   When the `closing` class is removed, there's a frame where the animation's `forwards` styles are
   gone but the resting-state styles haven't applied, and WebKit re-evaluates the compositing layer —
   a visible snap. (This is the sidebar flicker, exactly: `ts-sidebar-out ... forwards` + `setTimeout`
   removing `closing` after 380ms.)

**The fix is not to patch the keyframes. It's to replace the open/close model entirely** with the
architecture every flagship sheet/drawer uses: **a single spring-driven transform that is the source
of truth for the element's position at all times.**

---

## The canonical architecture (vaul / UIKit, applied to Svelte 5)

One physical model (position + velocity) owns the element's transform. **Every** interaction is the
same model, just changing position/target/velocity:

| Interaction                        | What it does to the model                                                 |
| ---------------------------------- | ------------------------------------------------------------------------- |
| Drag                               | sets position directly (finger tracking), samples velocity                |
| Release                            | injects the gesture's velocity, sets target = open-or-closed by threshold |
| Tap-away / close button            | sets target = closed (animates from CURRENT position)                     |
| Programmatic open/close            | sets target                                                               |
| Grab a closing sheet mid-animation | drag takes over from current position — **interruptible & reversible**    |

There is **no** separate "open animation," "close animation," or "drag animation." That unification
is what makes it feel alive. CSS keyframes for open/close are deleted.

### Implementation choice for Svelte 5

Svelte's `svelte/motion` `Spring` class is good but **does not expose velocity injection** — so for
true flick-carries-into-settle feel, use a **small custom rAF spring** (mass-spring-damper, semi-
implicit Euler). It's ~40 lines and it's the right call here because velocity handoff IS the flagship
feel. Pattern:

```ts
// motion/springValue.svelte.ts — single source of truth for one axis
export function createSpringValue(
	initial: number,
	{ stiffness = 170, damping = 26, mass = 1 } = {}
) {
	let pos = $state(initial);
	let vel = 0;
	let target = initial;
	let raf = 0;
	let onRest: (() => void) | null = null;

	function tick() {
		const dt = 1 / 60; // fixed step; clamp if you sample real dt
		const f = -stiffness * (pos - target) - damping * vel;
		vel += (f / mass) * dt;
		pos += vel * dt;
		if (Math.abs(vel) < 0.05 && Math.abs(pos - target) < 0.05) {
			pos = target;
			vel = 0;
			raf = 0;
			onRest?.();
			onRest = null; // ← unmount happens HERE, not on a timeout
			return;
		}
		raf = requestAnimationFrame(tick);
	}
	return {
		get value() {
			return pos;
		},
		set(p: number) {
			pos = p;
			if (!raf) {
			}
		}, // drag: direct position, no physics
		animateTo(t: number, velocity = 0, rest?: () => void) {
			target = t;
			vel = velocity;
			onRest = rest ?? null;
			if (!raf) raf = requestAnimationFrame(tick);
		},
		stop() {
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
		}
	};
}
```

```svelte
<!-- the sheet: transform is ALWAYS driven by the spring -->
<div class="sheet" style:transform={`translate3d(0, ${sheet.value}px, 0)`} style:will-change="transform">
```

- **Drag** (in the existing `sheetDrag` pointer handlers): `sheet.set(dragY)` each `pointermove`
  (apply rubber-band past bounds, below). The factory's finger-tracking logic is already correct —
  keep it; just have it drive the spring's position instead of writing `style.transform` directly,
  and DELETE the `externalExit` branch.
- **Release**: compute velocity (px/ms → px/s), then
  `sheet.animateTo(shouldDismiss ? FULL : 0, releaseVel, shouldDismiss ? unmount : undefined)`.
- **Tap-away / close button**: the SAME `sheet.animateTo(FULL, 0, unmount)` — animates from current
  position. No keyframe.
- **Unmount**: only in the `onRest` callback when the spring reaches the closed position. **Never a
  `setTimeout`.** This kills the flicker at the source.

### Thresholds & physics (flagship values, several already correct in the codebase)

- **Drag-to-dismiss:** ≥ 25% of sheet height (`CLOSE_THRESHOLD = 0.25` — keep).
- **Flick velocity:** > 0.4 px/ms carries to dismiss regardless of distance (`VELOCITY_THRESHOLD = 0.4` — keep).
- **Rubber-band past bounds** (pull sheet up past open, or drawer past closed) — UIScrollView's formula:
  `f(x, d, c) = (x * d * c) / (d + c * x)`, `c ≈ 0.55`, `x` = overscroll px, `d` = dimension. Apply to
  the over-drag portion so it resists with diminishing returns instead of moving 1:1.
- **Spring feel:** start `stiffness ~170, damping ~26, mass 1` (a touch of overshoot); tune by ear on device.

---

## Fix each surface

### 1. Model picker sheet (`ModelPickerChip.svelte` + `sheetDrag.svelte.ts`)

- **Delete** the `mpc-closing` / `mpc-sheet` open/close `@keyframes` and the `externalExit:true` path.
- Drive the sheet's `transform` from one spring (above). The existing drag tracking + velocity +
  `shouldDragSheet` (scroll-vs-drag arbitration) is good — rewire it to `spring.set()` / `spring.animateTo()`.
- Tap-away (scrim), close button, swipe-release, and `closeAllPopovers` ALL call the same
  `animateTo(closed, vel, unmount)`. Mount stays while `present` (logical-open OR spring-not-at-rest);
  unmount in `onRest`.
- Result: swipe continues fluidly from the finger; tap-away slides from full-open; both interruptible.

### 2. Sidebar drawer (`ThreadsSidebar.svelte`)

Two acceptable fixes — prefer **A** (it makes the drawer draggable too, matching iMessage/ChatGPT):

- **A (best):** same spring model on the X axis. Drag-to-open/close from the edge, velocity on release,
  tap-scrim/button set target. Symmetric by construction (one spring → open and close mirror each other).
- **B (minimum, kills flicker fast):** replace `@keyframes ts-sidebar-out ... forwards` + `setTimeout`
  with a **CSS transition on a state class** (WebKit-robust per research):
  ```css
  .drawer {
  	transform: translateX(-100%);
  	transition: transform var(--dur-panel) var(--ease-sheet);
  	will-change: transform;
  }
  .drawer--open {
  	transform: translateX(0);
  }
  ```
  Toggle only `.drawer--open`. Unmount the scrim on the panel's `transitionend`, not a timeout. No
  `forwards`, no class-removal race → no flicker. Make open and close the **same** duration/easing
  (the "close too fast" is an asymmetry — one transition rule fixes it).
- Either way: `will-change: transform` on the panel; scrim fade is a sibling `opacity` transition with
  the **same** duration so they move together.

### 3. Scroll smoothness (`+page.svelte` feed container, `MessageFeed`)

The research is blunt: **`scrollTo({ behavior: 'smooth' })` is janky on iOS WebKit** — it cancels
in-progress momentum and stutters when called repeatedly as messages stream. Current code calls
`scrollFeedToBottom('smooth')` in several places. Fixes:

- Feed container: `overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain;`
  (the `-webkit-` line is what gives native momentum/inertia; iOS Safari ignores `overscroll-behavior`
  for the document but it's harmless here).
- **Pinned-to-bottom logic:** auto-scroll ONLY when the user is within ~40px of the bottom; otherwise
  show the "new ↓" pill (already exists) and DON'T move them.
- When pinned and new content arrives: use **instant** `scrollTop = scrollHeight` (iOS handles the
  inertia naturally), NOT `behavior:'smooth'`. For the deliberate "jump to latest" tap, use a short
  **custom rAF ease** (≈180ms cubic-out), never the native smooth scroll, and never while the user is
  actively scrolling (track last-scroll timestamp).
- Never scroll the `body` — only the inner container (already true here; keep it).

---

## Why this is a foundation, not a patch

The model picker, the sidebar, the message-action sheet (Phase A `SullySheet`), the future RunSheet,
and parts of the voice surface (Phase C) all want the SAME spring-sheet behavior. Build it **once** as
a shared primitive (`motion/springValue.svelte.ts` + a `SpringSheet.svelte` wrapper around the existing
`sheetDrag` gesture logic), then every sheet/drawer in the app inherits flagship motion. This also sets
up Phase C's orb (amplitude → spring target) on the same engine. Doing it per-component with keyframes
is what produced the current inconsistency.

## Verification (motion can't be screenshot-verified — this is the gate)

1. **On-device feel** is the real test — the operator drags, flicks, taps-away, grabs-mid-close on the iPhone.
2. **Instrumented proof** (Playwright): sample the transform mid-gesture to assert it (a) tracks the
   finger during drag, (b) continues from the release position (no jump back to 0), (c) stays mounted
   until the spring rests. Assert NO `@keyframes`-based open/close remains on these surfaces.
3. **Flicker check:** record the close; assert the element's transform is monotonic to the closed
   position with no 1-frame reversal, and the scrim opacity decreases monotonically.
4. **Reduced-motion:** spring snaps to target instantly (skip the rAF loop) under `prefers-reduced-motion`.
5. **Scroll:** stream messages while scrolled up → the view must NOT yank; pinned → stays pinned smoothly.

## Paste-ready handoff (for CUR)

```text
The Phase B motion isn't flagship-fluid. Read docs/2026-06-12-motion-engine-the-fluidity-fix.md and
docs/2026-06-11-flagship-feel-research.md (Pattern 1/8). Root cause: open/close uses CSS @keyframes +
closing-flag + setTimeout-unmount, which can't continue from a finger drag, can't carry release
velocity, and flickers on close. Replace it with ONE spring-driven transform as the single source of
truth (custom rAF mass-spring-damper; velocity injected on release; unmount on spring-rest, not a
timeout) — build it as a shared primitive and apply to the model picker sheet AND the sidebar. Also
fix scroll: drop scrollTo({behavior:'smooth'}) on iOS (it kills momentum), use -webkit-overflow-
scrolling:touch + instant-when-pinned. Fresh branch off latest main, ONE PR, stop for my review.
Verify per the doc's gate (instrumented transform sampling + on-device), not screenshots. Reduced-
motion + data-testid hooks preserved.
```

## Sources

vaul drawer (Emil Kowalski) · Apple HIG sheets · UISpringTimingParameters / UIKit Dynamics ·
Radosław Holko — reverse-engineering UIScrollView rubber-band (`f(x,d,c)=xdc/(d+cx)`, c≈0.55) ·
Svelte 5 `Spring` (svelte/motion) · WebKit `animation-fill-mode: forwards` flicker
(stevenwoodson.com) · iOS `-webkit-overflow-scrolling` + overscroll behavior (bram.us, css-irl).
_(Full URLs in the session research log.)_
