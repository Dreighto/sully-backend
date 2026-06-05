# Sully Phase 5 — Verified Workspace + Artifact Preview (design)

**Date:** 2026-06-05 · **Status:** design approved (operator greenlit); ready for the 5a implementation plan. · **Builds on:** the shipped Task-first v1 (propose→confirm→dispatch→verify→synthesize, all proven live — `data/sully_behavior_audit_2026-06-04/`). · **Research basis:** `data/peer_reviews/2026-06-04_qol-notification-sdk-research.md` (§3 artifact preview/download, §4 SDK).

## Goal

Give Sully a place to **build real artifacts** (the first target: a "Today's Ops" dashboard; the everyday case: mockups, docs, small frontend builds), built the same trustworthy way as everything else — **a worker does the work, the result is verified against hard evidence, and the operator can preview + download it.** The operator stays in chat; Sully handles the plumbing. The model never gets a free-form write tool: only workers build, only inside a sandbox.

## Architecture: worker-builds-in-a-verified-git-workspace

The whole flow reuses the v1 pipeline. The only new ingredients are **a place to build (a workspace)** and **a way to see the result (a preview/download panel)**.

```
operator + Sully discuss → operator hands a reference (mockup/note)
  → operator asks to build it
  → Sully PROPOSES (Contract 1/2; ask-before-dispatch) — operator confirms (the approval gate)
  → Sully places the needed reference file(s) into the project folder + writes a self-contained brief
  → a WORKER is dispatched INTO the project folder (its cwd) → builds + commits
  → Go/No-Go poll confirms the COMMIT (verifyPoll git channel → real evidence, GO posture)
  → Sully SYNTHESIZES: "Built it — here's what changed" + a preview link
  → operator previews / downloads the artifact
```

## 1. The workspace model (sub-project 5a)

**One sandboxed git repo, a folder per project.** `~/dev/sully-workspace/` (a real git repo), with `todays-ops/`, `frontend-ideas/`, etc. inside. Each project folder holds both the operator's `refs/` (references) and the worker's output, together — so a context-less worker dispatched into the folder finds everything it needs in one place.

- **Registered as ONE new dispatch target.** Today Sully can only dispatch to `project-miru` / `LogueOS-Console` / `LogueOS-Orchestrator` / `NASDOOM` (the `REPOS` map in `src/lib/server/verifyPoll.ts` + the gateway's repo registry + `detectTargetRepo` in `src/lib/server/chat/stream_prepare.ts`). 5a adds `sully-workspace` to all three so a worker can be dispatched there and its commit can be verified. Because it's a git repo, **every build is a commit** — exactly the hard evidence the Go/No-Go `git` channel already checks (a real SHA → GO posture → Sully points to the commit, not a claim).

- **Reference placement (resolved decision): Sully files what a task needs, at dispatch.** The operator keeps chatting normally. When Sully proposes a worker task that needs a reference, she copies those specific file(s) into the project folder (`<project>/refs/`) as part of the dispatch and names them in the brief ("design reference: `refs/mockup-01.png`"). Plus an explicit **"save this to the project"** for durable assets (brand kit, a design system) the operator wants kept regardless of a task. Chat attachments come from the existing uploads pipeline (`src/routes/api/chat/uploads/`) — placement copies from there into the workspace.

- **Two small deterministic server-side writes (NOT the model, NOT a worker):** creating a project folder on first use, and placing a reference file. These are mechanical file ops confined to the workspace root — the model never authors arbitrary content this way. (Project creation: Sully proposes "I'll set up a workspace for X"; on confirm the folder is created + git-tracked.)

- **The approval gate = the existing propose→confirm.** A build only runs after the operator confirms the proposal (tap Run it / "yes"). No new approval surface for v1. (Later upgrade: the AI SDK v6 `needsApproval` tool-approval is the SDK-native form of this exact step — research §4 — adopt when convenient.)

## 2. Artifact preview + download (sub-project 5b)

A **side panel on desktop / full-screen sheet on phone**, brand-matched (magenta `#ec2d78`, brand tokens, rounded-full pills, the `DispatchChips`/`WorkingBubble` look — never generic zinc), rendering the artifact **by content type**:

- **MVP slice (ship first):** a path-confined file-serving endpoint `GET /api/workspace/[project]/files/[...path]` — renders **image inline**, **markdown formatted** (marked + DOMPurify), **code with a copy button**; `?download=1` → `Content-Disposition: attachment`; `?raw=1` → inline. **Copy-to-clipboard is the default action** (sidesteps iOS download quirks). Single-file download with an iOS-runtime branch: Capacitor shell → native `@capacitor/file-transfer` + Share; installed PWA → a URL outside the manifest `scope`; desktop → plain `Content-Disposition`. **HTML shown as source + download at first (no live execution).**
- **Deferred to a later slice:** live interactive HTML preview (must be served from a **separate `artifacts.<tailnet>` origin** in `<iframe sandbox="allow-scripts">` — never `allow-scripts allow-same-origin` together); zip-a-folder (streaming `archiver`); per-artifact version history.

**Security (load-bearing):** path-traversal confinement is the critical piece — URL-decode-in-a-loop, reject null bytes / absolute / UNC, `path.resolve(WORKSPACE_ROOT, …)`, boundary check `startsWith(root + sep)`, then `fs.realpath()` + re-check (defeat worker-created symlinks). Gate the endpoint behind the existing Funnel-header check (Tailscale is the boundary, no cookie auth). Untrusted generated HTML execution stays out of v1 (separate-origin slice later).

## 3. Verification tie-in (why this is "verified")

The worker commits its build into the project folder → `closeOutTask` runs the Go/No-Go poll → the **git channel** confirms the commit SHA in `sully-workspace` (real evidence) → GO posture → synthesis says "Built it — here's the commit + a preview link," with the same I1 discipline (no evidence → hedge, never false confidence). A read-only/no-change build (no commit) correctly returns UNKNOWN/hedge — proven by the live verify-stage test (2026-06-04). Artifacts become first-class **verified** outputs, not narrated claims.

## Build order (each ships on its own spec → plan → build)

- **5a — Workspace + dispatch-to-it** _(first; the capability):_ the `sully-workspace` git repo, registered as a dispatch target (REPOS map + gateway registry + detectTargetRepo), project-folder creation, reference placement, verification tie-in. Makes "Sully builds a verified artifact" possible. **← the first implementation plan.**
- **5b — Artifact preview + download panel:** the confined file-serving endpoint + the side-panel/sheet (image/markdown/code-with-copy + download + copy-default).
- **5c — "Today's Ops" dashboard:** the first real artifact, validating 5a + 5b end-to-end (the operator's original test project).

## Explicitly deferred (not Phase 5 v1)

Live interactive HTML preview (separate origin); zip-folder download; AI-SDK custom **data-parts** as a richer inline artifact/task-card UI (research §4 — a UI upgrade, layer on later); resumable streams (needs Redis); workspace **auto-suggest** (the "suggest instruction set + repo + dir on new workspace" vision); Pulse-style overnight catch-up; a Sully-direct write tool (explicitly rejected — workers build, not the model). These are real follow-ons, sequenced after 5a–5c.

## Out-of-scope interaction note

A separate agent is concurrently doing the notification + QOL batch (PRs #15/#16 shipped; Task 3 decision-push/lock-screen pending). Phase 5 must not collide with that surface; coordinate if the artifact panel touches notification/thread UI.
