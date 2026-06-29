# Animation perf measurement — Lottie cost on WebKit (for the flagship motion budget)

_CC, 2026-06-11, live prod build, iPhone 15 Pro Max viewport, CDP Performance counters, 10s windows after 2.5s settle._

| Surface | layouts/s | style recalcs/s | DOM node drift |
|---|---|---|---|
| Gallery — 8 live pills + 19 looping Lottie tiles (worst case) | **60** | **60** | −95 (stable) |
| Chat, idle | **0** | **0** | 0 |

## What this means

1. **The SVG Lottie player drives one layout + one style recalc per frame** while
   anything animates — the per-frame pipeline saturates at 60/s whether 1 or 27
   instances run (they batch into the same frame). So a single live WorkerPill
   costs ≈60 layouts+recalcs/s for the duration of a run.
2. **Idle is still 0/0/0** — the locked-spec tripwire holds; Lotties only run on
   trusted live work and pause offscreen (IntersectionObserver).
3. **Motion-layer consequence (CUR):** during a live run + streaming reply, the
   frame budget is already paying the Lottie tax. Phase A–C motion must stay
   CSS-compositor-only (transform/opacity — the hard rules already say this);
   do NOT add per-frame JS-driven animation on surfaces that can coexist with a
   running pill.
4. **Future lever if jank appears on device:** switch `WorkerStateAnim` from the
   SVG renderer to canvas (`lottie_light` → canvas renderer) — eliminates the
   per-frame layout/recalc entirely at the cost of crispness at very small
   sizes. Not needed until a real device shows jank; measure first.
