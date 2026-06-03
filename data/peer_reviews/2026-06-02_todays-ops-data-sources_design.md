# Today's Ops Dashboard — Wiring It to Reality

**Author:** CC (VP Ops) · 2026-06-02
**Context:** First real-world test project for the task-first architecture. The goal isn't a pretty page — it's a dashboard that always reflects **what is actually true right now**, assembled from machine-readable sources, never from an LLM guessing.

---

## The problem this fixes

When the operator asked Sully "where did we leave off?", she reconstructed the answer by grepping `codemagic.yaml`'s header comments and `.aider` history — and concluded the next milestone was **"Push Notifications (APNs), deferred to Build 2."**

That was **wrong by a full day's work**: APNs shipped end-to-end on build 15 (a test push hit the lock screen), plus talkback, cloud Emma, and task-first Phase 1. Sully gave a two-week-old snapshot because she read a stale artifact instead of the live record.

**The dashboard's job: make "what's true" a query, not a guess.** Same data should back Sully when she's asked the question conversationally.

---

## The real sources of truth (and what each one answers)

| Source                                                | Answers                                                                            | How to read it                                            | Status                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| **Git log** (per repo in `~/dev`)                     | "What actually got done, and when" + activity heat (active/paused/dormant)         | `git -C <repo> log --since --oneline --shortstat`         | ✅ exists                                         |
| **Task journal** (`chat_activity` + `turn_replay.ts`) | "What we worked on this session" — every turn as a Task with model/latency/outcome | `replayThreadRecent(thread, n)`; `SELECT … chat_activity` | ✅ exists (Phase 1)                               |
| **`pending_jobs`** (Task table)                       | Dispatched work + status (proposed→…→done/verified)                                | `getJobsForThread()` / `SELECT … pending_jobs`            | ✅ exists                                         |
| **Linear** (kernel PM)                                | "What's next" + roadmap (open issues, milestones, projects)                        | gateway `linear_*` tools / Linear GraphQL                 | ✅ exists (access path to confirm from companion) |
| **Projects registry** (new, small)                    | Operator-owned status per project: active / paused / future + one-line intent      | a tiny `ops_projects` table or JSON the operator edits    | 🔨 new (small)                                    |
| **Memory / handoff docs**                             | Non-obvious "why" + last handoff (`state-handoff-log.md`, session handoffs)        | machine-read of known files                               | ✅ exists                                         |

**Anti-pattern to retire:** reconstructing state from CI config comments, README prose, or `.aider` logs. Those are stale the moment they're written. (I just fixed the two `codemagic.yaml` / `ci-ios-patch.sh` headers that misled Sully — but the fix is to stop _depending_ on prose for state.)

---

## What the three panels show — with TODAY's real data

**Panel 1 — "Where we left off" (derived, zero operator input):**

From `git log --since='14 days'`, right now:

| Project              | Commits (14d) | Last commit                                              |
| -------------------- | ------------- | -------------------------------------------------------- |
| LogueOS-Companion    | **178**       | 06-02 22:12 · _fix(voice): self-heal poisoned local TTS_ |
| LogueOS-Console      | 146           | 05-28 · chat voice/talkback refactor                     |
| LogueOS-Orchestrator | 56            | 06-01 · canon refresh                                    |
| miru                 | 19            | 05-31 · image fetch manifest                             |
| nasdoom              | 0             | 05-15 · PWA optimization                                 |

→ The dashboard reads "Companion = active focus, Miru = paused, Nasdoom = dormant" **straight from commit heat** — exactly the priorities the operator had to tell Sully by hand. Plus the latest commit subject line per repo _is_ "where you left off," verbatim and current.

**Panel 2 — "What's next" (from Linear + open loops):**

- Open Linear issues for the active project(s), highest-priority first.
- Open loops mined from the journal: Tasks that reached `proposed`/`dispatched` but not `done`/`verified`; any `error` rows; flagged follow-ups.
- (Real example of what this would have caught: "APNs build" — except it's now `done`, which the dashboard would show correctly instead of as "next.")

**Panel 3 — "Roadmap" (projects registry + Linear projects):**

- The `ops_projects` registry: each project with status (active/paused/future), one-line intent, and a link. Operator-owned so _intent_ (which git can't infer) stays accurate — e.g. "Miru: first big project, paused until Companion ships."
- Augmented with Linear milestones/projects for the forward view.

---

## Architecture (server-side assembler + thin UI)

```
┌─────────────────────────────────────────────────────────┐
│  GET /companion/api/ops/snapshot   (server, cached ~60s) │
│   ├─ gitActivity()    → per-repo commits + last subject  │
│   ├─ journalRecent()  → turn_replay over recent threads  │
│   ├─ openLoops()      → pending_jobs not done + errors    │
│   ├─ linearNext()     → open issues (active project)      │
│   └─ projectsRegistry() → ops_projects (status + intent)  │
│  → returns one OpsSnapshot JSON                           │
└─────────────────────────────────────────────────────────┘
        │
   /companion/ops  (Svelte route)  →  three cards, auto-refresh
        │
   Sully reads the SAME assembler when asked "where did we leave off?"
```

- **One assembler, two consumers:** the dashboard renders it; Sully answers from it. That guarantees the chat answer and the dashboard never disagree (the root problem today).
- **Cheap + live:** each source is a fast read; cache the snapshot ~60s. No model in the hot path — it's data, not generation. Sully only _narrates_ the snapshot when asked.
- **Refresh:** on load + a 60s poll (or revalidate on focus). Git/journal/Linear are all sub-second.

---

## Why this is the right first task-first project

The journal is the spine. Today's Ops is essentially a **read-view over the task journal + git + Linear** — so building it exercises exactly the Phase-1 plumbing (`chat_activity`, `turn_replay`, `pending_jobs`) under real use, and surfaces whatever's missing before Phase 2/3 lean on it harder. It also closes the loop the operator named: _"I should see where we left off and what's next, plus a roadmap so I'm not just looking at what's in front of me."_

---

## Suggested phasing

- **MVP (1 sitting):** `gitActivity()` + `projectsRegistry()` (seeded with Companion/Miru/Nasdoom) + the `/ops` route with the three cards. Already-true on day one from git alone.
- **+ Journal:** wire `openLoops()` from `pending_jobs`/`chat_activity` so unfinished Tasks surface.
- **+ Linear:** pull open issues / milestones for the forward view.
- **+ Sully hook:** point her "where did we leave off / what's next" answers at the same `/api/ops/snapshot` so she stops guessing.

I can start on the MVP whenever you greenlight — it's small and immediately useful.
