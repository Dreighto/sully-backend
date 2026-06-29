# Phase 5 / 5a — Verified workspace + dispatch-to-it (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Spans TWO repos (Companion + LogueOS-Orchestrator). Spec: `docs/superpowers/specs/2026-06-05-sully-phase5-verified-workspace-design.md`. Grounded in a read-only dispatch-plumbing investigation (2026-06-05).

**Goal:** Make `sully-workspace` a real, dispatchable, **verifiable** target so Sully can: create a per-project workspace folder, place the references a task needs into it, dispatch a worker that builds + commits there, and have the Go/No-Go poll confirm the commit before she claims the artifact was built. (5b preview/download + 5c Today's Ops come after.)

**Architecture:** A sandboxed git repo at `~/dev/sully-workspace` (folders per project). Registered as a dispatch target in BOTH the Companion (routing + verification) and the gateway/kernel (worktree pool + project registry + approved-target set). References are **committed to `sully-workspace` main before dispatch** so the worker's worktree (provisioned from main) contains them. The worker builds + commits; the verifier checks the commit locally (the git channel needs no GitHub remote).

**Tech Stack:** SvelteKit server (Companion), Node dispatch listener + Python gatekeeper (Orchestrator), better-sqlite3, vitest + pytest.

**Two non-obvious realities (operator flagged before build):**

1. **5a touches the kernel/gateway (LogueOS-Orchestrator).** Three registry edits + a parity test. These are canon-sensitive — small, additive, but real kernel changes.
2. **Worktree freshness.** Workers run in a git _worktree_ of `sully-workspace` (`~/dev/worktrees/sully-workspace/wN`), not the main checkout. So references must be **committed to main before dispatch**, and the worker must start on the latest main content, or it won't see them.

---

## File structure (what changes)

**Prereq (one-time):** create `~/dev/sully-workspace` as a git repo (+ optional GitHub remote `Dreighto/sully-workspace`).
**Companion:** `src/lib/server/verifyPoll.ts` (REPOS entry); `src/lib/server/chat/stream_prepare.ts` (route artifact-builds → `sully-workspace`); NEW `src/lib/server/workspace.ts` (project-folder creation + reference placement, confined + commit-to-main); `src/lib/server/companionDispatch.ts` (call reference-placement before the dispatch POST when target is `sully-workspace`); tests.
**Orchestrator:** `data/worktree_pools.json` (add pool — config, no code); `services/dispatch_listener/src/projects.js` (PROJECT_REGISTRY); `tools/logueos_mcp_gateway/dispatch_tools.py` (`_APPROVED_TARGET_REPOS`); `tests/test_dispatch_tools_target_repo_parity.py` (keep parity green).

---

## Task 0: Prereq — create the sully-workspace git repo

**Files:** filesystem (`~/dev/sully-workspace`)

- [ ] **Step 1:** `git init ~/dev/sully-workspace` (default branch `main`); add a top-level `README.md` ("Sully's artifact workspace — one folder per project") + a `.gitignore`; `git -C ~/dev/sully-workspace add -A && git -C ~/dev/sully-workspace commit -m "init: sully-workspace"`. Confirm `git -C ~/dev/sully-workspace rev-parse main` succeeds.
- [ ] **Step 2 (optional, for the PR channel):** create the GitHub repo `Dreighto/sully-workspace` (private) + `git remote add origin` + push main. If skipped, the verifier's `git` channel still works locally; only the `pr` channel SKIPs (acceptable for 5a).
- [ ] **Step 3:** confirm the worktree slot parent can exist: `~/dev/worktrees/sully-workspace/` (the listener auto-provisions `w1` via `git worktree add` on first dispatch).

---

## Task 1: Orchestrator — register sully-workspace as a dispatch target

**Files:** Modify `data/worktree_pools.json`, `services/dispatch_listener/src/projects.js`, `tools/logueos_mcp_gateway/dispatch_tools.py`; verify `tests/test_dispatch_tools_target_repo_parity.py`

- [ ] **Step 1: Worktree pool (config, no code change).** Add to `data/worktree_pools.json`:

```json
"sully-workspace": ["/home/dreighto/dev/worktrees/sully-workspace/w1"]
```

(Loaded at listener startup via `_loadPoolConfig()` — merges over hardcoded `WORKTREE_POOLS`. One slot is enough for v1; artifact builds are serial.)

- [ ] **Step 2: Project registry.** In `services/dispatch_listener/src/projects.js` `PROJECT_REGISTRY`, add `'sully-workspace': 'sully-workspace'`.
- [ ] **Step 3: Approved-target set.** In `tools/logueos_mcp_gateway/dispatch_tools.py` `_APPROVED_TARGET_REPOS`, add `"sully-workspace"`. (MUST stay in parity with the pool keys — see the comment there.)
- [ ] **Step 4: Parity test green.** Run `python -m pytest tests/test_dispatch_tools_target_repo_parity.py` — confirm it passes (if it enumerates pool keys vs approved set, both now include `sully-workspace`). If the test reads `worktree_pools.json`, ensure consistency.
- [ ] **Step 5: Restart the listener** (standing authority): `sudo systemctl restart logueos-dispatch-listener.service`. Confirm active.
- [ ] **Step 6: Smoke** — a dummy `dispatch_worker(target_repo='sully-workspace', ...)` through the gatekeeper is ACCEPTED (not rejected as unknown target) and provisions `~/dev/worktrees/sully-workspace/w1`. (Don't run a real build yet — Task 5.) Commit each repo's changes (Orchestrator) with clear messages.

---

## Task 2: Companion — make the commit verifiable (REPOS entry)

**Files:** Modify `src/lib/server/verifyPoll.ts`; Test `tests/verify-channels.test.ts` (or the existing verifyPoll tests)

- [ ] **Step 1: Add the REPOS entry** (L87-101):

```ts
'sully-workspace': { root: '/home/dreighto/dev/sully-workspace', gh: 'Dreighto/sully-workspace' }
```

- [ ] **Step 2: Test** — a `verification_poll` for a `sully-workspace` job with a real commit SHA in `~/dev/sully-workspace` returns the `git` channel GO (mirror the existing git-channel test with the new repo key). `npx vitest run` + `npm run check` green.
- [ ] **Step 3: Commit.** `feat(5a): verifyPoll knows sully-workspace (git/pr channels resolve)`

---

## Task 3: Companion — workspace service (create project + place references, confined + committed)

**Files:** Create `src/lib/server/workspace.ts`, `tests/workspace.test.ts`

- [ ] **Step 1: Write failing tests** — `workspace.ts` exposes:
  - `WORKSPACE_ROOT = '/home/dreighto/dev/sully-workspace'`.
  - `ensureProject(project: string): {dir: string}` — slugifies `project`, creates `<root>/<project>/` + `<project>/refs/` if absent (path-confined: reject `..`/absolute/traversal — reuse the fs_guard confinement pattern), returns the dir. Idempotent.
  - `placeReference(project, srcPath, name): {path: string}` — copies `srcPath` (an existing upload in `chatUploadsDir`) into `<project>/refs/<name>` (confined to the workspace root; reject traversal; verify `srcPath` is within `chatUploadsDir`).
  - `commitWorkspace(message): {sha: string | null}` — `git -C <root> add -A && git commit -m <message>` (skip if nothing staged); returns the new SHA. This is the deterministic "place = a commit" so the worker's worktree (from main) sees the refs.
  - Tests: ensureProject creates the dirs + is idempotent; placeReference copies into refs/ + rejects a traversal name; commitWorkspace returns a SHA after a placement; a `..` project name is rejected.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `workspace.ts`** — pure-ish file ops + `execFile('git', …)` (argv, no shell), all paths `path.resolve`d + boundary-checked against `WORKSPACE_ROOT` then `realpath`-rechecked (defeat symlinks). No model input executed.
- [ ] **Step 4: Run, verify pass.** `npm run check` green.
- [ ] **Step 5: Commit.** `feat(5a): workspace service — confined project creation + reference placement + commit-to-main`

---

## Task 4: Companion — route artifact-builds to sully-workspace + place refs before dispatch

**Files:** Modify `src/lib/server/chat/stream_prepare.ts` (detectTargetRepo) + `src/lib/server/companionDispatch.ts` (pre-dispatch reference placement); Tests

- [ ] **Step 1: Routing.** In `detectTargetRepo`, route to `'sully-workspace'` for an explicit workspace/artifact-build signal — v1 keep it PRECISE (don't steal real repo work): an explicit `targetRepoHint==='sully-workspace'` OR a clear workspace phrase (e.g. `/\b(in|to|my) (the )?workspace\b/i` or "build/create … dashboard/mockup/artifact … in my workspace"). Bias to NOT misroute "fix the console repo". Add fixtures: "build me a dashboard in my workspace" → `sully-workspace`; "fix the console build" → `LogueOS-Console` (unchanged); plain chat unaffected.
- [ ] **Step 2: Pre-dispatch reference placement.** In `dispatchToWorker` (or just before the POST), when `targetRepo === 'sully-workspace'`: `ensureProject(project)` (project name derived from the brief/task or a thread-project context), `placeReference(...)` for each reference the task needs (from `chat_uploads` rows for this thread), then `commitWorkspace('refs: <project> — <n> reference(s) for <traceId>')`. The worker brief must (a) name the project folder + the `refs/` files, and (b) instruct: "start by syncing to the latest `main` content so the references are present, then build in `<project>/` and commit." (Freshness — Task 4 reality #2.)
- [ ] **Step 3: Tests** — routing fixtures (Step 1); a unit test that a `sully-workspace` dispatch calls `ensureProject` + `commitWorkspace` (mock the git/fs) before the POST, and a non-workspace dispatch does NOT. `npm run check` + `npx vitest run` green.
- [ ] **Step 4: Commit.** `feat(5a): route artifact-builds to sully-workspace + place+commit refs before dispatch`

---

## Task 5: End-to-end live validation (the Go/No-Go proof)

**Files:** none (a live, supervised run — like the v1 verify-stage test)

- [ ] **Step 1:** On a throwaway thread, drive a real workspace build through Sully: "create a todays-ops project and put a hello.md in it that says 'Sully was here'" (an artifact build → routes to `sully-workspace`). Confirm Sully PROPOSES; confirm it; the worker is dispatched into `~/dev/worktrees/sully-workspace/w1`.
- [ ] **Step 2:** After completion, verify in the journal: `verification_poll` resolves the **git channel GO** with a real commit SHA in `~/dev/sully-workspace`; the artifact (`todays-ops/hello.md`) exists in the repo; synthesis says "built it" with the commit, NOT a hedge. Confirm the reference-placement commit + the worker's build commit are both present.
- [ ] **Step 3:** Confirm no collateral: the worker stayed in the workspace (no commits to other repos); the main checkout isn't corrupted.
- [ ] **Step 4:** Record the result in `data/peer_reviews/2026-06-05_5a-workspace-live-validation.md`.

---

## Final review + deploy

- [ ] Companion: full `npx vitest run` + `npm run check` green. Orchestrator: parity + listener tests green.
- [ ] Adversarial review (focus: path-confinement in `workspace.ts` — no write escapes `WORKSPACE_ROOT`, traversal/symlink rejected; routing doesn't steal real-repo dispatches; reference-placement commits BEFORE the dispatch POST; the worker actually sees the refs (freshness); the kernel changes are additive + parity holds; no Phase-5b/5c scope crept in — NO preview endpoint, NO live HTML, NO direct Sully write tool).
- [ ] Deploy Companion (build + restart) after operator OK. Open PRs per repo for operator review/merge.
- [ ] **Deferred to 5b/5c (do NOT build here):** the artifact preview/download endpoint + panel; Today's Ops dashboard content; live HTML; SDK data-parts UI; auto-suggest.
