# Artifact Promotion & Durable Store — Design Spec

**Date:** 2026-06-08
**Status:** Approved (operator), ready for implementation plan
**Repo:** LogueOS-Companion
**Related:** memory `project_artifact_output_system_required`; Stage 4 read-side
(`/api/artifacts/[trace]/{list,file,bundle.zip}`); CDX audit should-fix
(buildFiles path-resolution inconsistency).

---

## 1. Problem

Workers (and eventually Sully) produce operator-facing deliverables — docs,
mockups, screenshots, exports, reports, generated files. Today the operator has
no phone-accessible path to them; they have to dig through code or sftp into the
box. The **read-side** shipped (Stage 4 endpoints + 9-field metadata), but the
**write/emission side** does not exist: nothing records what was produced or
copies it anywhere durable.

## 2. Core principle

> **Touched files are evidence. Promoted deliverables are artifacts.**

- **Evidence** = every file a worker touched (source edits, temp files, logs,
  worktree internals). Stays in the work-trace layer; visible behind the State C
  detail view; never surfaced as a deliverable.
- **Artifact** = an operator-facing deliverable that was **promoted**: copied
  into durable storage with creator metadata, surfaced in chat, openable /
  downloadable / shareable.

Promotion is **creator-agnostic** — a worker or Sully both promote through the
same pipeline. Sully **presents** artifacts; she is **not** the gatekeeper for
what gets promoted.

## 2.5. Download-integrity invariants (HARD GUARANTEE — non-negotiable)

Artifact surfacing is **download-backed, not path-backed.** Result Files is a
view of the durable manifest — never a view of whatever files the worker
happened to touch. The implementation MUST hold every one of these; they are
not best-effort UI niceties:

1. **Surfaced ⇒ durable.** If an artifact appears in Result Files, its durable
   copy already exists on disk. Nothing is surfaced before the copy succeeds.
2. **Manifest points only to the durable copy.** A manifest entry's path is
   relative to the store dir; no manifest entry ever references a worktree /
   raw worker path.
3. **Endpoints read the store only.** The single-file + bundle endpoints resolve
   strictly within the store dir for the trace. They never read a worker path.
4. **Surface only after copy + manifest write succeed.** The manifest is written
   atomically (temp file + rename); a partial/failed promotion never becomes
   visible. The `created_artifact` activity row (live-feed breadcrumb) is emitted
   only AFTER the manifest write — and is NOT itself the surfacing source.
5. **The manifest is the SOLE surfacing source.** Both the endpoints and the
   surface Result Files row read the manifest — not `created_artifact` rows, not
   `fs.existsSync` over touched paths. A file is in Result Files iff it is in the
   manifest.
6. **Failed promotions stay evidence.** A deliverable whose copy fails is NOT
   surfaced as an artifact; it remains `wrote_file` evidence and the surface
   shows a non-blocking warning ("1 deliverable couldn't be saved"), never a
   broken/clickable artifact.
7. **No 404 after cleanup.** Deleting the source worktree can never break a
   tap/open/download — the store copy is independent. This is an explicit test
   (§12), not an assumption.

## 3. Vocabulary (chat_activity actions)

| action                      | meaning                   | role                                                                            |
| --------------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| `wrote_file` / `write_file` | evidence — a touched file | State C "Evidence / work trace" only                                            |
| `created_artifact`          | promotion breadcrumb      | live activity feed only — emitted post-manifest-write; NOT the surfacing source |

This split is the on-the-wire encoding of the core principle. **Result Files is
sourced from the durable manifest (§2.5.5), not from these rows.** The
`created_artifact` row exists so the live feed shows "Created artifact X" as it
happens; the manifest is what makes it openable.

## 4. Promotion decision (priority order)

1. **Worker-declared (primary).** The worker lists its deliverables explicitly
   in the completion evidence envelope (new `artifacts` field). This is the
   intended path — the worker knows what it built for the operator.
2. **Heuristic safety net (secondary).** Before cleanup, scan `evidence.fs_paths`
   for obvious missed deliverables by extension / name and promote any not
   already declared:
   - extensions: `.pdf .md .html .svg .png .jpg .jpeg .webp .csv .zip` (+ `.json`
     only when name matches a deliverable pattern, to avoid promoting config).
   - name patterns: `*report*`, `*export*`, `*mockup*`, `*summary*`, `*deliverable*`.
3. **Exclusions (stay evidence unless explicitly declared).** Source edits
   (`.ts .js .svelte .py .go .rs …` that already existed), temp files, logs,
   `.git/`, `node_modules/`, lockfiles, dotfiles.
4. **Sully (presentation only).** Sully may review and present the final list,
   ordering by importance, but cannot add/remove promotions or block
   availability. "Available means available" stays deterministic.

## 5. Worker contract change (additive, backward-compatible)

Extend the dispatch completion evidence envelope (companion dispatch prompt in
`companionDispatch.ts`; note the kernel dispatch prompt may need the mirror
change — flagged as a plan item):

```jsonc
"evidence": {
  "fs_paths": ["<all files you created or edited>"],   // evidence (existing)
  "artifacts": [                                         // NEW — deliverables
    { "path": "demo/index.html", "label": "ChatGPT-clone mockup", "importance": "primary" }
  ],
  "git_ref": "<sha>", "repo": "<repo>", "pr_number": <n|null>, "health_url": "<url|null>"
}
```

- `path` required; `label` optional (human description); `importance` optional,
  one of `primary | secondary | supporting` (default `secondary`).
- Missing `artifacts` → heuristic safety net runs. Fully backward compatible.

## 6. Durable store

```
data/sully/artifacts/<YYYY-MM-DD>/<trace_id>/
   <relative_path…>        # copied deliverable(s), structure preserved
   manifest.json           # ArtifactMetadata[] for this trace (source of truth)
```

- **Date-partitioned** (`<YYYY-MM-DD>` from the task's start date) for storage
  scale / housekeeping.
- **Keyed by `trace_id`** (the surface's `surfaceId === trace_id`, so it lines
  up with the read endpoints).
- Read-side resolves a trace's dir by glob `data/sully/artifacts/*/<trace_id>/`
  (exactly one match) — so reads don't need to know the date.
- `manifest.json` is the **single source of truth** for both the endpoints and
  the surface Result Files row.

## 7. Metadata schema (per artifact, in manifest.json)

Extends the existing 9-field schema with `label` + `importance` (11 fields):

| field            | source                                                         |
| ---------------- | -------------------------------------------------------------- |
| `created_by`     | worker short-code (CC/AGY/…)                                   |
| `task_id`        | `pending_jobs.ticket_id` ?? trace_id                           |
| `trace_id`       | the trace                                                      |
| `timestamp`      | promotion time (or source mtime)                               |
| `source_worker`  | `pending_jobs.worker`                                          |
| `workspace_path` | the store dir for this trace                                   |
| `artifact_type`  | doc / mockup / screenshot / code / data / log / other (by ext) |
| `original_path`  | path relative to the store dir                                 |
| `artifact_url`   | `/api/artifacts/<trace>/<original_path>`                       |
| `label`          | worker-declared description, else derived from filename        |
| `importance`     | `primary` \| `secondary` \| `supporting` (default secondary)   |

## 8. Promotion pipeline (server-side)

Runs once per task at completion, in `closeOutTask` (`completionClose.ts`) — the
worker has reported `completed`, the worktree still exists, cleanup hasn't run.

Ordering enforces the §2.5 invariants: copy first, build the in-memory manifest,
write the manifest atomically, and only THEN emit the live-feed breadcrumbs.
Nothing is surfaceable until the manifest write succeeds.

```
promoteArtifactsForTask(traceId, evidence):
  job        = getJob(traceId)
  declared   = evidence.artifacts ?? []
  candidates = declared ∪ heuristicScan(evidence.fs_paths, excluding declared+exclusions)
  storeDir   = data/sully/artifacts/<date(job.started_at)>/<traceId>/
  promoted   = []          # successful copies → manifest
  failed     = []          # copy failures → stay evidence + warning (§2.5.6)

  for each candidate:
    src = resolveSource(candidate.path, worktreeRootFor(traceId))   // see §10
    try:
      assert exists(src)
      copy src → storeDir/<rel>            # copy BEFORE any surfacing (§2.5.1)
      assert exists(storeDir/<rel>)        # verify the durable copy landed
      promoted.push(buildArtifactMetadata(job, candidate, storeDir, rel))
    catch:
      failed.push(candidate)               # NOT surfaced as an artifact (§2.5.6)

  if promoted.length:
    writeFileAtomic(storeDir/manifest.json, promoted)   # temp + rename (§2.5.4)
    for m in promoted: emit chat_activity created_artifact (target=m.original_path)  # breadcrumb AFTER manifest
  if failed.length:
    emit chat_activity wrote_file for each failed        # stays evidence
    record a non-blocking promotion-warning on the surface (§2.5.6)
  # fs_paths NOT copied — they remain evidence
```

- The `created_artifact` rows are breadcrumbs for the live feed; the **manifest**
  is the surfacing source (§2.5.5). Emitting them after the atomic manifest write
  guarantees a surfaced artifact is already downloadable.
- Creator-agnostic public helper `promoteArtifact(traceId, absPath, meta)` so
  Sully (future write-tool) uses the identical path.
- Wrapped so a promotion failure never breaks task close-out.

## 9. Read-side rewire

Per §2.5.3 + §2.5.5 the manifest is the ONLY read source — no path on the read
side ever points at a worktree.

- `_artifactService.listArtifactsForTrace`: read `manifest.json` from the store
  (glob by trace_id) instead of re-deriving from activity rows + live `fs`.
  Single-file + bundle.zip resolve strictly within the store dir; a request that
  escapes it (or has no manifest entry) is 404, never a fallback to a worker path.
- `surfaceAdapter.buildFiles`: read the **same** manifest → the Result Files row
  and the endpoints always agree (fixes the CDX should-fix; removes the fragile
  `fs.existsSync(rawTarget)` + common-prefix workspace guess). No manifest → no
  Result Files row (only the optional promotion-warning).
- State C detail: **Result Files** = promoted artifacts from the manifest
  (ordered by importance: primary → secondary → supporting). A separate
  **Evidence / work trace** sub-section lists `fs_paths` (read-only, clearly
  labelled non-downloadable — these are NOT durable).

## 10. Known implementation risk

Resolving the **worktree root** for a trace at completion (to locate source
files from `evidence.fs_paths` / declared relative paths). `pending_jobs` does
not currently store it. Plan must pick: (a) stash `workspace_path` on the job at
dispatch (preferred), or (b) derive from `target_repo` + worktree-pool
convention, or (c) require workers to declare **absolute** artifact paths.
Absolute paths in `evidence.artifacts` sidestep this — the plan will likely
combine (a) + accepting absolute declared paths.

## 11. Out of scope (YAGNI / later)

- **Sully write-tool** — the promotion helper is creator-agnostic and ready, but
  no LLM write-tool is built this pass.
- **Artifact bundles as a grouped concept** — `bundle.zip` (download-all)
  already exists; richer grouped/named bundles are a later iteration.
- **Kernel dispatch-prompt mirror** — if kernel-dispatched workers use a separate
  prompt, updating it to emit `evidence.artifacts` is a follow-up (heuristic
  safety net covers them until then).

## 12. Testing

- **Unit:** promotion selection (declared primary; heuristic catches missed
  deliverables; exclusions hold); copy-to-store; atomic manifest write; metadata
  (incl. label + importance); read-from-manifest; failed-copy → stays evidence +
  warning, NOT surfaced (§2.5.6).
- **Required end-to-end (the persistence guarantee — §2.5.7):** this exact
  sequence is a must-pass test, not best-effort:
  1. Worker creates a file in its worktree.
  2. Worker declares it in `evidence.artifacts`.
  3. `closeOutTask` promotes it (copy → store).
  4. Manifest is written (atomically).
  5. Result Files reads from the manifest (file appears).
  6. **The source worktree is deleted.**
  7. A tap / open / download **still succeeds** (served from the store) — and
     `bundle.zip` still includes it. No 404.
- **Integration (negative):** a `completed` task whose declared artifact copy
  FAILS → no manifest entry, no Result Files row, file stays `wrote_file`
  evidence, surface shows the non-blocking promotion-warning. A read request for
  a path not in the manifest → 404 (never falls back to a worker path, §2.5.3).
- **Consistency:** the surface Result Files row matches the `/api/artifacts`
  listing byte-for-byte (same manifest source).

## 13. Success criteria

- A worker that produces a deliverable → the operator sees it in the chat Result
  Files row and can open / download / share it from the phone, with no sftp.
- A promoted artifact never 404s after worktree cleanup.
- Source edits / temp / logs never appear as deliverables.
- Every artifact carries full creator metadata (worker, task, trace, timestamp,
  label, importance).
