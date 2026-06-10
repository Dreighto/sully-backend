# Companion e2e harness — the contract (LOS-182)

The e2e suite is **hermetic by default**: every invocation spawns its own
production-build server on `127.0.0.1:5188` with a **fresh, empty SQLite DB**
under `.e2e-data/run-<pid>/` (gitignored, swept on the next run). It never
touches the live service (`:18769`) or the live `data/companion.db`.

## Why this exists

T2's resume-last-thread (LOS-178) is correct product behavior: once any thread
is persisted, opening `/companion/chat` resumes it instead of landing on the
empty greeting. Several specs assert the **clean-profile** rendering ("a clean
profile lands on the empty greeting"), so a reused, accumulated DB false-failed
4 specs during the LOS-181 verify, and under parallelism the suite passed or
failed by scheduling luck (LOS-185 evidence). Two guarantees fix that:

1. **Fresh DB per run** — the harness state starts empty, always.
2. **Staged scheduling** — specs that _assert_ empty state run before specs
   that _mutate_ chat state, enforced by Playwright project dependencies.

## The three stages (per engine)

| Stage | Project name                 | Specs                                                                   | Why                                                                                                                                                                   |
| ----- | ---------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `chromium` / `iphone-webkit` | `smoke.spec.ts`, `agy-probe/probe.spec.ts`, `agy-probe/phase7.spec.ts`  | The **empty-state trio** — read-only specs asserting the clean-profile greeting / empty visual baseline. Run first, isolated from any mutation.                       |
| 2     | `<engine>-rest`              | everything not in stages 1/3 (currently `a11y-scan`, `eruda`, `phase6`) | Read-only w.r.t. chat state. Defined by **exclusion**, so a new spec file lands here by default instead of silently never running.                                    |
| 3     | `<engine>-mutating`          | `composer-pulse-timing.spec.ts`                                         | Sends a **real chat turn** (persists a thread + `last_thread`). Runs last and alone: nothing observes "empty" after it, and its timing isn't skewed by parallel load. |

Stage-1 projects keep the original names because phase7's committed snapshot
baselines (`chat-empty-<project>-linux.png`) and probe.spec's
`docs/agy-audit-shots/<project>-*.png` filenames embed the project name.

**Adding a spec that mutates chat state** (sends a message, creates/deletes
threads, sets the active thread)? Add its filename to `MUTATING_SPECS` in
`playwright.config.ts`. Everything in stages 1–2 relies on chat state staying
clean while it runs.

## How to run

```bash
npm run build              # the harness serves build/, not src/ — see below
npm run test:e2e:webkit    # full iphone-webkit suite (all three stages)
npm run test:e2e:chromium  # full chromium suite
npm run test:e2e           # both engines, SEQUENTIALLY (fresh DB each)
```

- **Build first.** The webServer runs `node build/index.js`. Global setup
  fails fast if `build/index.js` is missing or older than the newest file in
  `src/` (override with `PLAYWRIGHT_SKIP_BUILD_CHECK=1` only when you know the
  src change is build-irrelevant).
- **Don't run bare `npx playwright test`** (no `--project` filter): both
  engines' stages interleave in one process, and engine B's stage-1 trio can
  race engine A's stage-3 mutator. There are deliberately no cross-engine
  dependency edges — they would drag the chromium chain into webkit-only runs.
  The npm scripts are the supported entry points; `test:e2e` runs the engines
  sequentially, each against its own fresh DB.
- Selecting a later stage directly (e.g.
  `npx playwright test --project=iphone-webkit-mutating`) is safe: Playwright
  project dependencies pull the earlier stages in automatically.
- One suite invocation per worktree at a time (port 5188 enforces this; the
  run-dir sweep in global setup assumes it).

## Escape hatch: external server

`PLAYWRIGHT_BASE_URL=<origin>` skips the managed webServer and global setup's
preconditions, and targets a server you manage — e.g. a live diagnostic over
Tailscale. **Non-hermetic**: the empty-state trio will false-fail unless the
target has a clean profile (no persisted threads). That is the exact failure
mode this harness was built to kill, so prefer the default mode for anything
that gates a PR.

`PLAYWRIGHT_PORT=<port>` moves the managed server off 5188 if you need to.

## Known limitations (deliberate, documented)

- **The pulse spec calls the real model.** `composer-pulse-timing` sends a
  chat turn through whatever `COMPANION_DEFAULT_MODEL` + provider keys the
  worktree `.env` configures (currently a cloud model). A provider outage or
  quota trip fails the run — that's an environment failure, not a regression.
  The `.env` at the repo root is required (global setup fails fast without it)
  and is never committed.
- **`a11y-scan` "chat with messages" is weak on a fresh DB.** It deep-links a
  thread id that doesn't exist on a fresh DB, so the resolver falls through to
  an empty thread and the scan exercises the empty surface instead of the
  reply-footer buttons. Pre-existing (the fresh-DB EXIT-0 baseline in LOS-182
  already ran this way). Future fix: a deterministic seed fixture in stage 2,
  or promote it to a mutating spec that sends a real turn first.
- **`phase6` writes `docs/phase6_results.json`** and probe.spec rewrites
  `docs/agy-audit-shots/*.png` — committed files, so a run can dirty the tree.
  Pre-existing probe behavior; don't commit those diffs unless refreshing the
  audit evidence is the point.
