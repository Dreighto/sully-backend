# AGY Mobile/iOS Audit Findings — 2026-06-01

## TL;DR
- 0 critical, 1 high, 2 medium, 1 low, 0 nit
- Top 3 things Captain should look at first:
  1. Fix the `label-content-name-mismatch` accessibility issue in the header button.
  2. Increase small tap targets (< 44x44px) across the app to meet Apple HIG.
  3. Verify keyboard reflow and safe-area insets on a real iOS device, as Playwright Linux WebKit cannot accurately test them.

## What was tested
- Tools used: Playwright chromium + iphone-webkit, Lighthouse, vitest.
- Surfaces covered: /companion/chat empty state, model picker, composer focus, visual baselines, tap target sizes.
- Surfaces NOT covered + why: voice mode (avoiding cost), dispatched workers (parallel CC running), real iOS device behaviors (Linux WebKit limitations).

## Findings

### HIGH — Accessibility: label-content-name-mismatch
**Where:** `header.relative > div.flex > div.relative > button.flex`
**Evidence:** Lighthouse a11y audit report.
**Repro:** 
1. Run Lighthouse on `/companion/chat`.
2. Observe the failed `label-content-name-mismatch` audit.
**Suggested investigation:** Check the `aria-label` vs visible text in the header component.

### MEDIUM — Tap targets smaller than 44x44px (Apple HIG)
**Where:** Various buttons in the chat UI.
**Evidence:** Phase 6 Playwright probe.
**Repro:** 
1. Open `/companion/chat` on a mobile viewport.
2. Inspect button dimensions. Found heights of 28px, 33.98px, and 36px.
**Suggested investigation:** Review `button` classes and increase padding/min-height to 44px for touch targets.

### MEDIUM — Mobile Performance Score 81
**Where:** `/companion/chat`
**Evidence:** Lighthouse mobile run.
**Repro:** 
1. Run Lighthouse with mobile form factor.
2. Score is 81. Top failed audits include `redirects`, `unused-javascript`, `meta-description`, `cache-insight`.
**Suggested investigation:** Address unused JS and cache policies to improve mobile load performance.

### LOW — iOS behaviors need real device verification (needs verification)
**Where:** Composer focus and safe-area insets.
**Evidence:** Linux WebKit test results.
**Repro:** N/A
**Suggested investigation:** Verify on real iPhone via Tailscale. The viewport reflow and `env(safe-area-inset-*)` did not trigger in Playwright WebKit on Linux, which is expected.

## Lighthouse scores

| Page | Form factor | Perf | A11y | BP | SEO |
|---|---|---|---|---|---|
| /companion/chat | desktop | 99 | 100 | 100 | 91 |
| /companion/chat | mobile  | 81 | 100 | 100 | 91 |

## Console errors / failed network calls observed

- None observed during test runs. All existing 119 vitest and 10 e2e tests passed.

## Coverage gaps

- Real iOS Mobile Safari rendering (URL-bar resize, exact JIT, safe areas).
- Voice mode and cloud TTS/LLM integrations (skipped due to cost constraints).
- Dispatched worker impacts (skipped to avoid interfering with parallel training run).

## STOP

Don't fix anything. Captain + main CC own the fix prioritization.
