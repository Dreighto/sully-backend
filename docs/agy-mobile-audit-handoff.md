# AGY mobile / iOS audit — handoff prompt

For a fresh AGY (Antigravity CLI) terminal. Paste the block at the bottom
as the first message. AGY does the audit autonomously, produces a single
findings doc, then stops. Main CC reviews + decides what to fix.

The audit is **read-only** — no code modifications, no commits, no service
restarts, no touching the parallel CC's training run.

## Why this lane

Captain just shipped:

- `playwright.config.ts` with `chromium` + `iphone-webkit` projects
  (WebKit binary at `~/.cache/ms-playwright/webkit-2287`, Linux Safari
  engine — not iOS Mobile Safari, see caveats)
- `tests/e2e/smoke.spec.ts` + `eruda.spec.ts` — minimal coverage
- Lighthouse CLI 13.3.0 at `~/.npm-global/bin/lighthouse`
- Eruda mobile devtools (toggle via `?debug=1` URL param)
- Responsively desktop AppImage at `~/Applications/`

The tools are in place. What's missing: a **thorough audit run** against
the real app surface using all of them, so we know what to fix before
the next UI iteration.

## Scope guards

- **DO NOT** modify any `.ts` / `.svelte` / `.py` source file
- **DO NOT** commit anything to git, do not push
- **DO NOT** restart `logueos-companion` or any `logueos-*` service
- **DO NOT** touch `scripts/finetune/` — parallel CC's training run is
  in flight (PID 1168568 last seen, watch but don't kill)
- **DO NOT** generate cost-incurring data (image gen, cloud TTS,
  cloud LLM calls beyond what existing tests already make)
- **DO NOT** invent findings — every claim cites a screenshot, a
  command output, or a file path with line number. If you can't repro,
  mark it "needs verification" not "issue"
- **DO** create exactly ONE output file:
  `docs/2026-06-01-agy-mobile-audit-findings.md`

## Output contract

Single markdown report, structured as:

```
# AGY Mobile/iOS Audit Findings — 2026-06-01

## TL;DR
- N critical, N high, N medium, N low, N nit
- Top 3 things Captain should look at first

## What was tested
- Tools used: Playwright chromium + iphone-webkit, Lighthouse, Eruda, ...
- Surfaces covered: /companion/chat empty state, /companion/chat with
  thread loaded, model picker, composer, thumbs-up, ...
- Surfaces NOT covered + why: voice mode (cost), dispatched workers
  (parallel CC running), ...

## Findings

### CRITICAL — [title]
**Where:** file path with line numbers, OR URL + visual
**Evidence:** screenshot path / command output / console log
**Repro:** numbered steps
**Suggested investigation:** which module/file to look at

### HIGH — [title]
...

### MEDIUM — [title]
...

### LOW — [title]
...

### NIT — [title]
...

## Lighthouse scores

| Page | Form factor | Perf | A11y | BP | SEO |
|---|---|---|---|---|---|
| /companion/chat | desktop | xx | xx | xx | xx |
| /companion/chat | mobile  | xx | xx | xx | xx |

## Console errors / failed network calls observed

bulleted list with surface + error string + frequency

## Coverage gaps

what the test suite still doesn't exercise

## STOP

Don't fix anything. Captain + main CC own the fix prioritization.
```

## Phases (run in order)

Each phase: 1-line status to stdout before starting. ALL outputs land
in `docs/2026-06-01-agy-mobile-audit-findings.md` (overwrite-as-you-go
is fine — final state matters).

### Phase 1 — sanity + non-interference

```bash
cd ~/dev/LogueOS-Companion
nvidia-smi | head -15
pgrep -af 'unsloth\|train_qlora' || echo "  training process not visible"
curl -sf http://localhost:18769/companion/ -w "  HTTP %{http_code}\n" -o /dev/null
sudo systemctl is-active logueos-companion
```

Confirm: companion serving, training still running, VRAM not full (we
don't want a Playwright headless browser spike to OOM the trainer).

### Phase 2 — existing test pass (baseline)

```bash
npm test                     # vitest unit suite, expect 119/119
npm run test:e2e             # smoke + eruda x 2 engines, expect 10/10
```

If anything fails, that's a CRITICAL finding — record it.

### Phase 3 — iphone-webkit deep probe

Write **new** test files under `tests/e2e/agy-probe/` (this dir is fine
to create — it's test code, not source). Cover at minimum:

- Empty thread state — sidebar visible (lg), hidden (sm), greeting renders
- Pick a thread with messages — scroll discipline, bubble rendering,
  action buttons (copy/regen/play/thumbs-up/thumbs-down) all clickable
- Model picker — open, all options visible, no overflow on iphone-webkit
- Composer — focus state, autosize, send button enabled/disabled gating
- Thumbs-up flow — click, persistence, click again to clear
- Sully avatar states — empty/thinking/working/voice transitions

For each: capture `await page.screenshot({ path: "docs/agy-audit-shots/<name>.png" })`
on the iphone-webkit project. Compare to chromium screenshots side by side.

### Phase 4 — Lighthouse desktop + mobile

```bash
mkdir -p /tmp/lh-out
lighthouse http://localhost:18769/companion/chat \
  --preset=desktop --quiet --chrome-flags="--headless" \
  --output=json,html --output-path=/tmp/lh-out/chat-desktop
lighthouse http://localhost:18769/companion/chat \
  --form-factor=mobile --throttling-method=simulate \
  --quiet --chrome-flags="--headless" \
  --output=json,html --output-path=/tmp/lh-out/chat-mobile
```

Extract category scores + the top 5 specific audits that came back below
score=1.0 for each form factor. Note the exact audit IDs (not Lighthouse
prose summaries).

### Phase 5 — accessibility scan

Either via `lighthouse --only-categories=accessibility` or a Playwright
test using `@axe-core/playwright` (you'll need `npm install --save-dev
@axe-core/playwright` first — that IS allowed since it's a dev tool
addition for the audit, not source code).

Report failures by axe rule ID (color-contrast, aria-required-children,
etc.) with the offending DOM node selector and the page URL.

### Phase 6 — keyboard / touch / safe-area on iphone-webkit

This feeds Captain's Task #28 (iOS keyboard-open delay). Specifically test:

- Composer focus on iphone-webkit — does the viewport reflow?
  `interactive-widget=resizes-content` is set in app.html, behavior expected.
- Safe-area inset values — read `env(safe-area-inset-top|bottom)` via
  `getComputedStyle` to confirm they resolve non-zero on the iPhone 15 Pro Max descriptor
- Tap target sizes — find every clickable element <44x44 px (Apple HIG)
- Bottom nav / composer visibility relative to the home indicator area

Caveat to state in the report: Playwright WebKit is desktop WebKit on Linux,
NOT iOS Mobile Safari. iOS-specific behaviors (URL-bar resize, input-zoom,
exact JIT) won't reproduce — flag those as "verify on real iPhone via Tailscale"
follow-ups, don't claim them as confirmed bugs.

### Phase 7 — visual regression baselines

For stable surfaces (NOT animation-heavy), capture `toHaveScreenshot()`
baselines. Mark which surfaces are too animation-y to baseline (thinking
dots, monster avatar transitions, fly-in popovers).

```ts
await expect(page).toHaveScreenshot('chat-empty.png', { maxDiffPixels: 50 });
```

These baselines land at `tests/e2e/agy-probe/*-snapshots/` and are
committable IF the main CC approves their quality. Don't commit yourself.

### Phase 8 — synthesize

Roll all of the above into the single output doc per the template.
Severity ladder:

- **CRITICAL** — broken core feature, app crash, data loss path
- **HIGH** — visible regression, accessibility blocker, perf <50
- **MEDIUM** — non-blocking bug, perf <80, missing affordance
- **LOW** — polish, copy nit, edge-case render
- **NIT** — taste-level

Then STOP. Print the report file path to stdout and exit.

## Status updates AGY should give while running

After each phase:
1 plain-English line (what got done, what surfaced, going to phase N+1).
Captain reads these without context-switching. Don't flood — one update
per phase, not per command.

If a phase errors uncatchably (e.g., Playwright can't launch WebKit):
STOP, post the error + diagnosis in plain English. Don't retry blindly.
Don't try to fix the test runner — flag it to main CC.

---

## THE PASTE BLOCK

(give this verbatim to AGY as the first message)

```
You are AGY (Antigravity CLI) instance running a mobile/iOS audit of the
LogueOS-Companion app. Your only output is ONE markdown file at
docs/2026-06-01-agy-mobile-audit-findings.md. You do NOT modify any source
code, do NOT commit anything, do NOT restart services. Read-only audit
producing structured findings.

Captain is not a coder — every status update to stdout MUST lead with plain
English. Technical detail goes below a --- divider.

Working dir:
  cd /home/dreighto/dev/LogueOS-Companion

Full runbook for you (read it first):
  docs/agy-mobile-audit-handoff.md

Run the eight phases in order:
  1. Sanity + non-interference (verify parallel CC's training still running, don't touch)
  2. Existing test pass — npm test + npm run test:e2e
  3. iphone-webkit deep probe — new tests under tests/e2e/agy-probe/
  4. Lighthouse desktop + mobile against /companion/chat
  5. Accessibility scan (lighthouse a11y or @axe-core/playwright)
  6. Keyboard / touch / safe-area on iphone-webkit (feeds Task #28)
  7. Visual regression baselines for stable surfaces
  8. Synthesize into the single output doc

After EACH phase, give a one-line status update in plain English.

Hard rules:
  - DO NOT edit any .ts / .svelte / .py source file outside tests/e2e/
  - DO NOT modify or touch scripts/finetune/ (parallel CC's training is live)
  - DO NOT run npm run build, git commit, git push, or any systemctl restart
  - DO NOT incur cost (no image gen, no cloud TTS, no cloud LLM calls beyond
    what existing tests already make)
  - DO NOT invent findings — every claim cites a screenshot path, command
    output, or file:line. Mark unverifiable items "needs verification"
  - DO NOT suggest fixes without a clean repro — main CC owns fix decisions
  - Playwright WebKit on Linux is NOT iOS Mobile Safari. iOS-specific
    behaviors (URL-bar resize, input-zoom, exact JIT) cannot be confirmed
    by you — flag them as "verify on real iPhone via Tailscale" follow-ups

When phase 8 is done:
  - Print the final report path to stdout
  - Print a one-line summary (N critical / N high / ...)
  - STOP. Do not propose fixes. Do not iterate. Main CC decides what to fix.

If anything errors uncatchably, STOP and post the error + your plain-English
diagnosis. Don't retry blindly; flag back to main CC.
```
