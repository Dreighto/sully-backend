# CC Sanity-Check — `real_assets_v4_final` mock vs. v1 API contract

**Reviewer:** CC · **Date:** 2026-06-06
**Reviewed:** `review_queue/demos/real_assets_v4_final/` (HTML/CSS/JS)
**Against:** `docs/design/Sully_Work_Surface/work_surface_api_contract.md` (v1 FINAL)

## Verdict

**Good to build from — after 3 quick renames.** The mock is clean, data-driven
(one `PRESETS` entry per scenario), and the graph is computed from worker count (no
hardcoded coordinates) — that matches the contract's design principle exactly. The
issues are **naming/enum collisions**, not structural problems. Fix the 3 HIGH items
below _before_ AGY builds, or the field named `role` will mean opposite things on the
two sides and we'll unwind it later.

Scope note: this demo is the **worker-graph + motion** asset (its own README reviews
icons/animation/ripples/settle). It covers the _active_ states well; the full
lifecycle (Stopped/Failed + the action buttons) lives in the contract and still needs
building — see Coverage Gaps.

---

## HIGH — fix before AGY builds (naming collisions → rework if skipped)

**H1. `role` means the wrong thing.** In the mock, `role: "Claude Code"` is the
**vendor identity**. In the contract, `role` is the **functional** role
(`Research | Build | Review | Memory | Vision | Voice`). The mock's _functional_ role
actually lives in `motionType` (`researching/building/verifying`).
→ Rename mock `role` → `identity` (or `display`), and add a real `role` derived from
`motionType`: `researching→Research`, `building→Build`, `verifying→Review`,
`blocked→` (keep prior role), `complete→` (keep prior role).

**H2. Short-code drift: `GEM`/`COD` → `GMI`/`CDX`.** The mock uses `GEM` (Gemini) and
`COD` (Codex); the contract + the live roster use `GMI` (Gemini-via-Aider, worker id
`gmi`) and `CDX` (Codex, worker id `cdx`). Same workers, different codes.
→ Rename `GEM`→`GMI`, `COD`→`CDX`. Keep `AGY` (Antigravity) separate from `GMI` —
they're distinct workers (different engine/auth), so the mock correctly shows both.

**H3. State enum mismatch.** Mock `status` has **4** values
(`working/checking/blocked/complete`); the contract `state` has **8/9**
(`Reading/Planning/Working/Reviewing/Waiting/Delivering/Complete/Stopped/Failed`).
`statusText` ("Researching", "Brainstorming", "Coordinated"…) is free **display** text,
not the enum. → AGY renders against the contract's `state` enum and treats the mock's
`status`/`statusText` as display hints. Mapping: `working→Working`,
`checking→Reviewing`, `blocked→Waiting`, `complete→Complete`.

---

## MEDIUM — coverage gaps (in the contract, absent from this demo)

**M1. No `Stopped` and no `Failed` preset.** `Failed` is **locked decision #1**
(distinct red card). There's also no `Reading`/`Planning`/`Delivering` example.
→ Add at minimum a `Stopped` and a `Failed` preset so AGY has something to render +
verify those cards (Failed = red banner + the failure reason from `proof`).

**M2. Only `Approve` is wired; `Stop Task` / `View Result` / `Start Over` are
missing.** This demo is graph-focused. Those three buttons (contract §9) still need
building, and they need data: `complete` needs a `result` with files for **View
Result**; a `Stopped` preset needs **Start Over**.

**M3. `multi-worker` (3 concurrent: CC+AGY+CDX) is a v2 scenario.** Per **locked
decision #2**, v1 = a single Build worker **+ the DeepSeek Review worker** (1–2 nodes).
→ Keep this preset as a forward-looking demo (it proves the graph scales — good!), but
label it **v2**; v1 live data won't produce 3-worker teams yet.

---

## MEDIUM/LOW — structured-data reconciliations (renderable now, lossy vs contract)

**S1. `proofScore` is a free-text label** ("94% Confidence", "Override Req.",
"100% Success") vs the contract's structured `Proof { verdict, score, checks[] }`. No
`checks[]` array for the Expanded "automated test reports."
→ v1 can render the free-text label; but the Expanded test-report needs `checks[]`.
Decide: v1 free-text proof, structured `checks[]` in v2 — or structure it now.

**S2. `phases[]` are bespoke per-task sub-steps, not the canonical 6-stage timeline.**
The contract makes `Read→Research→Build→Check→Approve→Reply` the compact-card backbone
(`stageProgress`). The mock's `phases` (e.g. "Mapping tables & indexing schemas") are
great as the **Expanded vertical checklist** but aren't the fixed 6 stages.
→ Keep `phases` as the Expanded checklist; add the fixed 6-stage `stageProgress` for
the compact timeline (backend derives it).

**S3. The destructive case isn't flagged structurally.** `waiting-approval` ("Delete
production database backup logs") is destructive, but there's no `isDestructive: true`
field — it's implied by text. **Locked decision #3** wants the double-confirm bound to
a field, not a text match. → Add `isDestructive: true` to that preset.

**L1. Missing runtime fields** (expected for a visual mock): no
`traceId/threadId/ticketId/startedAt/endedAt/result.files`. Backend supplies these —
fine to omit visually, but build the components against the contract types so they're
not bolted on later.

---

## Mock → contract field map (hand this to AGY)

| mock field                    | contract field                         | action                                                     |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `title`                       | `title`                                | ✓ as-is                                                    |
| `status` (4 vals)             | `state` (8/9 vals)                     | map per H3; add Reading/Planning/Delivering/Stopped/Failed |
| `statusText`                  | _(display hint only)_                  | not the enum                                               |
| `worker.key` (CC/AGY/DPSK)    | `worker.shortCode`                     | ✓; **`GEM`→`GMI`, `COD`→`CDX`** (H2)                       |
| `worker.icon`                 | → `worker.identity`                    | `icon-claude→claude-code`, etc.                            |
| `worker.role` ("Claude Code") | `worker.identity` / `display`          | **rename — it's identity, not role** (H1)                  |
| `worker.motionType`           | `worker.role` (Research/Build/Review)  | **this is the real functional role** (H1)                  |
| `worker.desc`                 | `worker.step`                          | ✓                                                          |
| `phases[]`                    | Expanded checklist                     | keep; separate from `stageProgress` (S2)                   |
| _(none)_                      | `stageProgress[]` (the 6 stages)       | **add** (S2)                                               |
| `proofScore` / `proofDetail`  | `proof.score` / `verdict` / `checks[]` | structure it (S1)                                          |
| _(none)_                      | `isDestructive`                        | **add `true`** on waiting-approval (S3)                    |
| `bannerText` / `prompt`       | `block { reason, kind, targetPath }`   | derive on Waiting                                          |
| _(none)_                      | `result { files }`                     | add for `complete` (View Result)                           |
| _(none)_                      | `traceId`/`threadId`/`ticketId`/times  | backend-supplied                                           |

---

## Bottom line for AGY

Build the components against the **contract types** (`WorkSurfaceTask`), using this
mock as the **visual + content** reference. Apply H1–H3 to the mock first (3 renames),
add the Stopped/Failed presets (M1) and the action data (M2), and treat
`multi-worker` as v2 (M3). Everything else (S1/S2/S3) is a clean, additive layer on
top of a solid foundation.
