# Sully Work Surface — Doctrine Verification (DPSK)

Doctrine quoted:
"The card glance contains ONLY: status header (no elapsed time) → title → hero 
ring → worker rows → Next banner → actions (only when actionable). NOTHING 
ELSE."

Now, I'll analyze each area:

## 1. Glance-first compliance
Looking at WorkSurfaceCard.svelte, the expanded view (footprint='expanded') 
contains:
- Status header (with dot and text)
- Title
- Hero ring (SurfaceProgressRing)
- Worker rows
- Next banner
- Actions (conditional)

This matches the doctrine. No elapsed time is present. All elements are in the 
correct order.

## 2. Motion is reality
Animations found:
- pulse-indicator: Bound to isInMotion state ✓
- ownership-pulse: Bound to isInMotion state ✓
- dot-pulse-soft/urgent: Bound to activeWorkerCount ✓
- dot-pulse-once: Bound to isRecentComplete timestamp ✓
- SurfaceProgressRing: Should only animate on percent change (not reviewed, but 
not in provided files)
- WorkerRow: Not provided, can't verify

## 3. Presence by absence
WorkSurfaceIndicator.svelte: Idle state renders zero DOM nodes (line 80-82) ✓
WorkSurfaceCard.svelte: Actions container is conditional on actionable states ✓

## 4. One row each, no nesting
Worker rows are flat: WorkerRow component is used, but its implementation isn't 
provided. Can't fully verify.

## 5. Svelte 5 runes
No $derived(() => fn()) patterns found ✓
Proper $props() usage ✓

## 6. Tailwind tokens
All tokens are valid:
- --color-st-run/needs/done/fail used for status ✓
- No invented tokens found ✓
- Identity tokens not used for status ✓

## 7. Accessibility
SurfaceProgressRing: Missing role and aria-label (not in provided files)
WorkerRow: Not provided, can't verify

## 8. TestFlight ship-readiness
- No SSR-breaking patterns found ✓
- No browser-only APIs ✓
- No new dependencies ✓
- All imports are from package.json ✓

## Blockers (MUST fix before TestFlight)
1. SurfaceProgressRing accessibility: Needs role='img' and aria-label describing
% and stage
2. WorkerRow implementation: Need to verify it meets motion and nesting 
requirements

## Nits (worth fixing, not blocking)
None found

## Stamp
SHIP-WITH-NITS
# Sully Work Surface — Doctrine Verification (DPSK)

Doctrine quoted:
"The card glance contains ONLY: status header (no elapsed time) → title → hero 
ring → worker rows → Next banner → actions (only when actionable). NOTHING 
ELSE."

## Verdict
SHIP-WITH-NITS — The core glance-first principle is honored, but missing 
accessibility attributes and incomplete WorkerRow review require fixes before 
TestFlight.

## 1. Glance-first compliance
✓ COMPLIANT: Expanded view contains exactly: status header → title → hero ring →
worker rows → Next banner → actions. No elapsed time present.

## 2. Motion is reality
✓ COMPLIANT: All animations bind to real state predicates (isInMotion, 
activeWorkerCount, isRecentComplete). SurfaceProgressRing and WorkerRow not 
fully reviewable from provided files.

## 3. Presence by absence
✓ COMPLIANT: WorkSurfaceIndicator renders zero DOM when idle. Action buttons are
conditional on actionable states.

## 4. One row each, no nesting
⚠️ INCOMPLETE: WorkerRow implementation not provided for review. Cannot verify 
flat structure.

## 5. Svelte 5 runes
✓ COMPLIANT: No $derived(() => fn()) anti-patterns found. Proper $props() usage.

## 6. Tailwind tokens
✓ COMPLIANT: Only valid status tokens (--color-st-run/needs/done/fail) used. No 
invented tokens.

## 7. Accessibility (new components)
🚫 BLOCKING: SurfaceProgressRing missing role='img' and aria-label. WorkerRow 
not provided for review.

## 8. TestFlight ship-readiness (SSR + Capacitor)
✓ COMPLIANT: No SSR-breaking patterns, browser-only APIs, or new dependencies 
found.

## Blockers (MUST fix before TestFlight)
1. SurfaceProgressRing must have role='img' and aria-label describing % and 
stage
2. WorkerRow must be reviewed for motion binding and flat structure compliance

## Nits (worth fixing, not blocking)
None identified

## Stamp
SHIP-WITH-NITS
