# 2026-06-10 Companion Audit

Linear: LOS-197  
Branch: `audit/los-197-companion-audit`  
Scope: read-only audit across `~/dev`; the only write is this report in the leased `w1` worktree.

## Executive Verdict

Companion production is the canonical checkout at `/home/dreighto/dev/LogueOS-Companion`, served by `logueos-companion.service` from `WorkingDirectory=/home/dreighto/dev/LogueOS-Companion` and `ExecStart=/usr/bin/node --env-file=/home/dreighto/dev/LogueOS-Companion/.env build/index.js` (`systemctl cat logueos-companion.service`, 2026-06-10 22:13Z). The leased audit branch and canonical checkout are both at `0f5588e` (`feat(work-surface): retire legacy card, part 1`, 2026-06-10 14:38:30 -0700); the audit branch is not the live service source.

The precise death point for stale trace `sully-1781123047255-171f42a1` is between the dispatch listener terminal record and Companion's `/api/chat/activity` terminal callback path: the listener wrote `worker_terminal` with `status=INCONCLUSIVE` at `2026-06-10T20:48:11.149Z`, but live `companion.db` still has `pending_jobs.status='working'`, `ended_at=NULL`, and no `completed` or `failed` activity row for that trace. Because `dispatchStream.svelte.ts` and the SSE endpoint reconcile only from `pending_jobs.status`, the client keeps rendering the run as live.

## Mission A - Inventory Verdicts

| Location                                                             | Verdict                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/home/dreighto/dev/LogueOS-Companion`                               | canonical/live                                  | `systemctl cat logueos-companion.service` points `WorkingDirectory` and `ExecStart` here; git `main...origin/main`, HEAD `0f5588e`; directory mtime `2026-06-10 14:38:42 -0700`.                                                                                                                                                                                                                 |
| `/home/dreighto/dev/worktrees/LogueOS-Companion/w1`                  | active audit worktree                           | Branch `audit/los-197-companion-audit...origin/main`, HEAD `0f5588e`; directory mtime `2026-06-10 14:37:50 -0700`; not the live service source.                                                                                                                                                                                                                                                  |
| `/home/dreighto/dev/agents/cc/LogueOS-Companion`                     | stale duplicate                                 | Branch `agent/cc/work...origin/agent/cc/work`, HEAD `989b1a3`; directory mtime `2026-06-08 19:33:16 -0700`; separate agent checkout, not referenced by systemd.                                                                                                                                                                                                                                  |
| `/home/dreighto/dev/sully-workspace`                                 | adjacent canonical workspace, not Companion app | Branch `_parking_sully-workspace`, HEAD `36928fd`; directory mtime `2026-06-05 13:00:25 -0700`; Companion dispatch code treats it as a target repo for workspace builds, not as the app (`src/lib/server/companionDispatch.ts:50-56`, `src/lib/server/companionDispatch.ts:116-123`).                                                                                                            |
| `/home/dreighto/dev/work-surface-live`                               | archive-candidate / static prototype            | Directory exists, mtime `2026-06-06 17:51:11 -0700`; no git state found in the inventory command; not referenced by live service.                                                                                                                                                                                                                                                                |
| `/home/dreighto/dev/companion-speech`                                | adjacent voice service repo                     | Branch `main...origin/main`, HEAD `1e6dc21`; directory mtime `2026-06-10 15:10:02 -0700`; contains voice assets such as `voices/sully_goodman.wav`, not the SvelteKit app.                                                                                                                                                                                                                       |
| `/home/dreighto/dev/worktrees/companion-speech`                      | voice worktree pool                             | Directory exists, mtime `2026-06-10 14:53:07 -0700`; adjacent to Companion but outside app runtime.                                                                                                                                                                                                                                                                                              |
| `/home/dreighto/dev/_archive/work-surface-abc`                       | archive                                         | Directory mtime `2026-06-08 21:56:27 -0700`; under `_archive`, not referenced by systemd.                                                                                                                                                                                                                                                                                                        |
| `/home/dreighto/dev/_archive/companion-canonical-cleanup-2026-06-09` | archive                                         | Directory mtime `2026-06-09 21:56:38 -0700`; under `_archive`, not referenced by systemd.                                                                                                                                                                                                                                                                                                        |
| `/home/dreighto/dev/LogueOS-Companion/static/facelift/*`             | stale mockups retained inside canonical repo    | 14 HTML mockups found: `integrated-mockups-v2.html`, `depth.html`, `integrated-mockups-v4.html`, `integrated-mockups-v3.html`, `integrated-mockups.html`, `index.html`, `glass.html`, `sidebar-layouts.html`, `polish-tactile.html`, `sidebar.html`, `aurora.html`, `polish-soft.html`, `audit-questions.html`, `final.html`; they are static reference/mockup files, not mounted Svelte routes. |
| `/home/dreighto/dev/training-corpora/companion-*`                    | canonical training artifacts, not runtime       | Found `companion-v2-best`, `companion-v2-lora`, `companion-v3-lora`, `companion-2026-06-01`, `companion-dispatch-2026-06-06`; not referenced by systemd app start.                                                                                                                                                                                                                               |
| `/home/dreighto/dev/odysseus/companion`                              | separate product area                           | Found by `find ~/dev -maxdepth 3` with tests `test_companion_readonly.py` and `test_companion_pairing.py`; no evidence it is the LogueOS Companion app runtime.                                                                                                                                                                                                                                  |
| `/home/dreighto/dev/LogueOS-Orchestrator/companion`                  | kernel-side companion integration               | Found by inventory; read-only evidence source for listener logs and canon, not SvelteKit runtime.                                                                                                                                                                                                                                                                                                |

Live data note: the real DB is `/home/dreighto/dev/LogueOS-Companion/data/companion.db`; the worktree also has `/home/dreighto/dev/worktrees/LogueOS-Companion/w1/data/companion.db`, but all trace reads in this audit used `sqlite3 'file:/home/dreighto/dev/LogueOS-Companion/data/companion.db?mode=ro'` per the worktree-DB rule.

## Mission B - Pipeline Trace

### Intended Pipeline

1. Companion dispatch creates/promotes a task row with `createJob()` (`src/lib/server/companionDispatch.ts:95-108`) and writes a prompt file under the Companion data dir (`src/lib/server/companionDispatch.ts:131-144`).
2. Companion POSTs to the dispatch listener (`src/lib/server/companionDispatch.ts:149-170`), then marks the job `dispatched`.
3. Workers are instructed to POST progress and terminal rows to `/api/chat/activity` (`src/lib/server/companionDispatch.ts:63-71`).
4. `/api/chat/activity` writes every activity row, then maps `completed` to `markDone()` and `failed` to `markFailed()` (`src/routes/api/chat/activity/+server.ts:90-114`).
5. The SSE endpoint emits visible `chat_activity` rows and sends `__terminal__` only when `getJob(traceId)` has a terminal status (`src/routes/api/chat/dispatch/stream/+server.ts:48-80`).
6. The client first reconciles from `/api/chat/dispatch/[trace]`, then opens SSE only when status is not terminal (`src/lib/chat/dispatchStream.svelte.ts:135-194`).
7. `MessageFeed.svelte` renders `WorkerPill` for `system` messages whose trace starts with `sully-` (`src/lib/components/MessageFeed.svelte:125-145`).
8. `WorkerPill` treats only mapped terminal statuses as done/failed/stopped; unknown/non-terminal statuses keep the elapsed timer live (`src/lib/work-surface/pill/pillModel.ts:30-58`, `src/lib/work-surface/pill/WorkerPill.svelte:61-78`).

### Case Study: `sully-1781123047255-171f42a1`

DB row from the live canonical DB:

- `pending_jobs.id=255`, `worker='claude-code'`, `status='working'`, `current_activity='thinking loading dispatch-worker skill + pre-flight'`, `started_at='2026-06-10 20:24:07'`, `ended_at=NULL`, `thread_id='chat-di2c764s'`.
- `result_ref` still contains the original proposal JSON for "Dispatch DPSK and run an audit on the icons being used for the companion app."
- `chat_activity` rows stop at id `917`, action `ran`, target `DPSK round 1 produced audit content but no file commit ... round 2 running ...`, timestamp `2026-06-10 20:47:06`.
- There is no `completed` or `failed` activity row in `chat_activity` for this trace.

Listener/orchestrator evidence:

- `/home/dreighto/dev/LogueOS-Orchestrator/logs/dispatch_listener_stdout.log` records `worker_terminal` for `trace_id='sully-1781123047255-171f42a1'` at `2026-06-10T20:48:11.149Z`, `worker='claude-code'`, `exit_code=0`, `status='INCONCLUSIVE'`, `duration_ms=1444727`, `stdout_bytes=502`, `stderr_bytes=0`.
- `/home/dreighto/dev/LogueOS-Orchestrator/logs/dispatch_listener_traces/sully-1781123047255-171f42a1.stdout.log` is only 502 bytes and ends with "DPSK round 2 is still streaming ... holding until then." The paired stderr log is 0 bytes and `.done` is 78 bytes.
- `/home/dreighto/dev/LogueOS-Orchestrator/data/cc_heartbeat_log.jsonl` has spawn ticker heartbeats for the trace from `2026-06-10T20:24:11Z` through `2026-06-10T20:47:11Z`.

Death point: the listener terminal state is not bridged into Companion's `/api/chat/activity` callback contract. The app has code to reconcile terminal state if a worker POSTs `action='completed'` or `action='failed'`, but there is no observed row showing that the listener's own `worker_terminal status=INCONCLUSIVE` was converted to a Companion terminal callback. Since `pending_jobs.status` remains `working`, both `/api/chat/dispatch/[trace]` and `/api/chat/dispatch/stream` truthfully tell the client the job is still live.

Likely fix direction, without implementing it here: add a listener-to-Companion closeout bridge that POSTs `failed` for non-success terminal statuses (`INCONCLUSIVE`, `FAILED`, timeout, nonzero exit) or teach Companion to ingest listener terminal webhooks directly. The bridge must preserve the existing raw worker callback path and should be idempotent against a late worker `completed` row; `/api/chat/activity` already tolerates duplicate/illegal transitions by logging and warning (`src/routes/api/chat/activity/+server.ts:93-118`).

## Mission C - Staged Refactor Proposal

### Measured Baseline

Initial static counts from this worktree:

- Svelte files: 49.
- TypeScript files under `src`: 180.
- `src/lib/components/*.svelte`: 27.
- `src/lib/work-surface/**/*.svelte`: 12.
- `src/routes/**/*.svelte`: 10.

Build measurement, run in `/home/dreighto/dev/worktrees/LogueOS-Companion/w1`:

- `npm run build` passed on 2026-06-10 22:16Z.
- SSR transform count: 4,572 modules; client transform count: 4,622 modules.
- Build time: client 3.80s, service worker 7ms, server 8.42s.
- Largest client JS chunks: chat page node `nodes/5.CKiSSouk.js` 270.58 kB / 87.03 kB gzip, shared chunk `D-18c9KW.js` 193.56 kB / 48.12 kB gzip, work-surface hybrid route `nodes/10.DJNS5mNy.js` 85.64 kB / 25.14 kB gzip, chunk `wAoPiPo3.js` 63.25 kB / 24.09 kB gzip.
- Largest client CSS assets: global/layout `0.DWCayra1.css` 97.69 kB / 19.53 kB gzip, `WorkSurfaceCard.B_JqjYK4.css` 42.83 kB / 6.61 kB gzip, work-surface hybrid route CSS `10._EH1ejB2.css` 20.70 kB / 3.83 kB gzip.
- Largest server bundles: `entries/pages/chat/_page.svelte.js` 313.34 kB / 51.78 kB gzip, `entries/pages/work-surface-hybrid/_page.svelte.js` 133.64 kB / 29.06 kB gzip, `index.js` 123.19 kB / 31.21 kB gzip, `chunks/WorkSurfaceCard.js` 77.73 kB / 12.79 kB gzip.
- Build warnings: deprecated `config.kit.csrf.checkOrigin`; Svelte warnings in `ImageLightbox.svelte:73`, `WorkSurfaceCard.svelte:129`, `WorkSurfaceCard.svelte:967`, and `WorkSurfaceCard.svelte:978`; circular dependency in `node_modules/zod/v4/classic/*`.

Type-check measurement:

- `npm run check` passed on 2026-06-10 22:16Z.
- `svelte-check` found 0 errors and 8 warnings in 5 files: `WorkSurfaceCard.svelte`, `DispatchChips.svelte`, `Icon.svelte`, `ImageLightbox.svelte`, and `SurfaceProgressRing.svelte`.

Largest source surfaces by bytes:

|   Size | File                                                    | Refactor signal                                                                                             |
| -----: | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 56,125 | `src/routes/chat/+page.svelte`                          | Main orchestration hotspot: messages, dispatch streams, activity polling, surface spawning, composer state. |
| 28,140 | `src/lib/components/WorkSurfaceCard.svelte`             | Legacy/work-surface candidate for quarantine or extraction.                                                 |
| 27,264 | `src/lib/components/Composer.svelte`                    | Clear `SullyComposer` extraction target.                                                                    |
| 24,495 | `src/lib/work-surface/hybrid/HybridDetailSheet.svelte`  | `SullyDrawer` / run-detail candidate.                                                                       |
| 22,990 | `src/lib/work-surface/hybrid/HybridDispatchCard.svelte` | `SullyWorkerRunPill` / artifact-card overlap.                                                               |
| 21,549 | `src/lib/components/WorkGraph.svelte`                   | Legacy visualization candidate.                                                                             |
| 17,331 | `src/lib/components/VoiceMode.svelte`                   | `SullyVoiceOverlay` extraction target.                                                                      |
| 16,381 | `src/lib/components/MessageFeed.svelte`                 | `SullyThreadItem` and `SullyWorkerRunPill` mount point.                                                     |
| 15,864 | `src/lib/components/Markdown.svelte`                    | Thread item rendering dependency.                                                                           |
| 15,747 | `src/lib/components/ThreadsSidebar.svelte`              | Drawer/sidebar pattern input.                                                                               |

Re-render and state hotspots from source reads:

- `src/routes/chat/+page.svelte` mutates `messages` in many paths (`:59`, `:74`, `:333`, `:391`, `:631`, `:691`, `:786`, `:859`, `:895`) and owns two timers (`pollMessages` every 3s and `pollActivity` every 5s at `:972-1036`).
- `ensureDispatchStream()` is called from a template-side `{@const}` in `MessageFeed.svelte` (`src/lib/components/MessageFeed.svelte:134`) and starts a browser `EventSource` per `sully-*` trace (`src/routes/chat/+page.svelte:192-220`, `src/lib/chat/dispatchStream.svelte.ts:114-133`).
- `traceToSurface` is `$state` and mutates from stream callbacks (`src/routes/chat/+page.svelte:153-159`, `:201-207`), so terminal handling can re-render the chat shell even when the visible feed item is the only affected surface.
- `WorkerPill` owns a one-second interval while non-terminal (`src/lib/work-surface/pill/WorkerPill.svelte:61-78`), which is correct for live runs but makes stale non-terminal rows expensive and visually misleading.

### Component Catalog

| Proposed primitive   | Current variants to replace or normalize                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SullyButton`        | Inline buttons in `Composer.svelte`, `ChatHeader.svelte`, `ThreadsSidebar.svelte`, message action buttons in `MessageFeed.svelte`, dispatch chips in `DispatchChips.svelte`. |
| `SullyCard`          | `ProofCard.svelte`, `WorkSurfaceCard.svelte`, `DispatchCard.svelte`, `HybridDispatchCard.svelte`, `WorkspaceContextModal.svelte` panels.                                     |
| `SullyPill`          | `SullyNameTag.svelte`, `DispatchChips.svelte`, worker/status chips in `WorkerRow.svelte`, pills in `HybridDispatchPill.svelte`.                                              |
| `SullyComposer`      | Extract from `Composer.svelte` and `WorkSurfaceComposerChrome.svelte`; keep chat and work-surface composer behavior behind one tokenized shell.                              |
| `SullyThreadItem`    | Extract from `MessageFeed.svelte` branches: operator bubble, Sully/local markdown message, system worker-pill row, thinking/tool rows.                                       |
| `SullyArtifactCard`  | `ProofCard.svelte`, artifact listing/rendering in `Markdown.svelte` and artifact endpoint consumers.                                                                         |
| `SullyWorkerRunPill` | Landed `src/lib/work-surface/pill/WorkerPill.svelte`, plus old `DispatchCard.svelte`, `HybridDispatchPill.svelte`, `HybridDispatchCard.svelte`, `WorkSurfacePill.svelte`.    |
| `SullyDrawer`        | `ThreadsSidebar.svelte`, `HybridDetailSheet.svelte`, `WorkspaceContextModal.svelte`, canvas/lightbox/modal shells.                                                           |
| `SullyVoiceOverlay`  | `VoiceMode.svelte`, voice picker controls, avatar state mapping, transcript overlay.                                                                                         |

### Staged Migration Order

1. Lock tokens and aliases in `src/app.css` first. Do not create new colors/radii/shadows outside the locked Sully token surface.
2. Extract `SullyButton`, `SullyPill`, and `SullyCard` as low-risk primitives, then swap only leaf call sites.
3. Extract `SullyWorkerRunPill` around the already-landed `WorkerPill` model; retire old dispatch card variants only after parity tests prove feed rendering still works.
4. Extract `SullyThreadItem` from `MessageFeed.svelte` to reduce the chat feed branch surface without changing stream behavior.
5. Extract `SullyComposer`; this is higher risk because `Composer.svelte` owns input, model picker, file paste, voice, slash commands, and dispatch intent.
6. Extract `SullyDrawer` and normalize sheet/modal/sidebar behavior.
7. Extract `SullyVoiceOverlay` last; voice code has runtime service dependencies and should not be moved during the worker-run fix.
8. Quarantine old components per build-then-delete discipline: unmount first, keep compatibility exports while tests and build pass, delete only in a follow-up PR after no imports remain.

### Gates Before Refactor

- Fix terminal reconciliation first; stale "live" worker pills make any performance or UX refactor hard to verify.
- Add/keep focused tests around `dispatchActivityView`, `dispatchStream`, `WorkerPill`, and `MessageFeed` before moving components.
- Treat the measured chat page, work-surface hybrid page, global CSS, and `WorkSurfaceCard` bundles as the first refactor targets; do not optimize smaller surfaces until these are isolated.
