# Autonomous Run Dossier — Sully Work Surface + Odysseus Adoption

**Window:** 2026-06-04 → 2026-06-06 (visible-dispatch mode).
**Operator:** AFK / autonomous, "where I can always see the process" (:8455 dashboard).
**Purpose of this file:** durable record for (a) team memory and (b) the eventual
Sully QLoRA training run. Captures the dispatch ledger, artifacts, learnings, and
the training-worthy trajectories.

---

## 1. Dispatch ledger (HMAC → kernel listener :19100)

Convention: non-LogueOS workers (AGY/GMI/CDX/DPSK) log `INCONCLUSIVE` + `exit 0`
on clean success (no STATUS marker emitted) — verify success by diff/artifact, not
the marker. Traces: `LogueOS-Orchestrator/logs/dispatch_listener_traces/<trace>.{stdout,stderr}.log`;
receipts: `data/n8n_inbox/<trace>.result.json`.

| Worker                       | Role this run          | Outcome      | Notes                                                                                                                |
| ---------------------------- | ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| AGY (antigravity)            | First-choice builder   | mixed        | Several builds timed out ~300s with no commit → diagnosed service-down; one `CONFIRMED_WORKING`. Fell back to GMI.   |
| GMI (aider+gemini-2.5-flash) | Frontend finisher      | success (×5) | Chunked the Work Surface lift; auto-commits to parking worktree. Recurring Tailwind/Svelte-5 bugs CC fixed (see §3). |
| CDX (codex exec)             | Read-only investigator | success (×2) | Odysseus pattern-mining + the CI/CD audit. Strong long-form analysis.                                                |
| DPSK (aider+deepseek)        | Reviewer               | success (×2) | Design/code review passes.                                                                                           |

Recipe (reusable): `~/dev/work-surface-live/wsd.py dispatch <worker> <repo> <abs_prompt.json>`
then `wsd.py wait <trace>`. Resilience log: `~/dev/work-surface-live/RUNBOOK.md`.

## 2. Artifacts shipped (all on `main`)

- **Work Surface lift** — mock → typed Svelte 5 component set: `src/lib/types/workSurface.ts`,
  `src/lib/data/workSurfaceSeed.ts` (10 presets), `StageTimeline` / `WorkSurfaceCard` /
  `WorkGraph` (animated sweep + gliding packets) / `PhaseChecklist` / `WorkerRegistry` /
  `ProofCard`, route `work-surface-preview`.
- **Mobile fix** — wrapper `justify-center`→`justify-start` + `overflow-y-auto` (expanded
  card was clipped + unscrollable on phone; app shell locks body overflow). Commit `8f5421b`.
- **CI fix** — 25 svelte-check errors → 0 (`score?: number|null`, worker-node `kind`,
  null-narrow `allRoutes`, footprint cast). Commit `76814be`. CI green since.
- **Odysseus adoption** — `2026-06-06_odysseus-adoption-roadmap.md` (8 items → 1 Execution
  Capability Graph) + do-first #1 Shared Endpoint Shape (`src/lib/types/endpoint.ts` +
  kernel `.logueos/reference/endpoint_shape.md`).
- **Reports** (this folder): `2026-06-06_token-budget-report.md`, `_qwopus-bench.md`
  (hermes4:14b beat Qwopus3.5:9b — not adopted), `_odysseus-pattern-mining-cdx.md`,
  `_ci-cd-audit-cdx.md`, `_odysseus-adoption-roadmap.md`.
- **Infra** — Odysseus self-hosted AI-workspace cloned + Ollama-wired + tailnet `:8460`
  (8 models); build dashboard `:8455`; WS mobile preview `:8461`.

## 3. Learnings (team memory + training signal)

1. **Green CI ≠ working build.** `ci.yml` runs `check`+`test`+scorecard only — NOT
   `npm run build`. Add build to the gate. (CDX audit.)
2. **svelte-check is stricter than the dev server.** The lift compiled in dev but had 25
   type errors CI caught. Run `npm run check` before pushing Svelte work.
3. **Mobile centering trap.** `min-h-screen`+`justify-center` clips tall content top+bottom
   when the app shell locks `html/body { overflow:hidden }` — the wrapper needs
   `overflow-y-auto` + top-align to become the scroll container.
4. **AGY down → GMI fallback** is a real failure mode; ~300s timeout + no commit = service
   down, not a slow build. Diagnose by checking for any commit on the parking worktree.
5. **GMI Tailwind-4 hallucinations** (recurring): invents tokens (`border-border-alt`,
   `text-primary`, `status-cyan`), uses `-10` not `/10` opacity, `@apply` without
   `@reference`. Always CC-review GMI's CSS.
6. **Two IPA pipelines** (Codemagic + GH Actions) = split release authority — pick one
   before the IPA ship. (CDX audit ship-blocker.)

## 4. QLoRA training-worthy trajectories (for the Sully local-model run)

Per `project_sully_task_first_phase1` ("data factory"). Highest-value examples here:

- **Synthesis examples** (high-quality long-form reasoning → structured output): the 5
  peer-review reports in this folder, esp. the adoption roadmap (multi-source synthesis)
  and the CI/CD audit (investigation → prioritized blockers).
- **Agentic dispatch trajectories** (plan → dispatch → verify → fix loops): the kernel
  dispatch traces for this run (`ws-{agy,gmi,cdx,dpsk}-*`), paired with the CC fixes that
  followed each (the §3 bug-fix loop is a clean "review → correct" pattern).
- **Operator-facing communication** (plain-English-first → technical below the divider):
  CC's turn outputs this run model the Operator Communication Standard.
- **Decision-under-ambiguity** (fail-closed): the kernel-canon audit (verify-then-commit)
  and the voice-WIP-preservation (commit-by-path, never `git add -A`).

Corpus pointer: `~/dev/training-corpora/companion-dispatch-2026-06-06/` (manifest +
source links). Do NOT pre-format to instruction/response pairs yet — per
`feedback_research_finetune_first`, the formatting pass happens at training-prep time.

## 5. CI / ship state (CDX audit 2026-06-06)

- `main` CI: **green**. GH Actions iOS/TestFlight: **green**. Keepalive: green.
- Ship-blockers before next IPA: (1) pick ONE pipeline; (2) verify signing material
  (ASC auth + cert key) from the real control plane; (3) pre-ship verify from a CLEAN
  checkout (local tree is dirty, local `npm test` red there).
- Nice-to-have: add `npm run build` to CI; Playwright smoke lane; fix workflow/docs drift.
