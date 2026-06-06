# Work Surface ↔ Backend API Contract (v1)

**Status:** v1 FINAL — operator-approved 2026-06-06 (decisions locked, §11)
**Purpose:** the seam between the Work Surface frontend and the Companion backend.
The frontend agent builds the UI against the **types + endpoints** here; the backend
agent implements the **projection + new routes** here. Neither side should invent a
parallel shape.

**Source of truth for behavior:** `sully_workflow_model.md` (this folder).
**Source of truth for data:** the existing dispatch FSM in
`src/lib/server/dispatchJobs.ts` (`JobStatus` / `PendingJob`). This contract is a
**projection** over that FSM — it does **not** replace it. We translate the messy
internal lifecycle into the clean model the UI renders.

---

## 1. Design principles

1. **Projection, not rewrite.** The backend already runs a 13-state job FSM
   (`proposed → … → synthesized`). The Work Surface needs a _coarser, presentational_
   view (8 states, 6 stages). We map the former onto the latter in one server-side
   function and expose the result. The internal FSM is untouched.
2. **Additive endpoints.** Reuse `/api/chat/dispatch/*` (already exists). Extend the
   per-task GET to return the projection; add three small routes (`stop`, `approve`,
   `files`). The single-file server `/api/workspace/[project]/files/[...path]` is
   already merged (`main` @ `7947cf1`).
3. **The frontend computes layout; the backend supplies graph data.** Per the
   workflow model §10, the SVG engine lays out nodes from their count. Backend sends
   `nodes[]` + `edges[]`; it does **not** send coordinates.
4. **Honesty over completeness.** Today dispatch is effectively **single-worker**
   (propose → confirm → one worker → synthesis). The multi-worker _team_ model
   (Research + Build + Review running together, the rich node graph) is the model's
   _target_, not today's reality. The types below support the full model; the v1
   backend populates a single `Build` worker. Flagged inline as **[future]**.

---

## 2. The canonical Task object

What `GET /api/chat/dispatch/[trace]` returns (the projection the whole UI reads):

```ts
export interface WorkSurfaceTask {
	traceId: string;
	threadId: string | null;
	title: string; // PendingJob.brief — the one-line task description
	state: TaskState; // §3 — the 8 lifecycle states (drives the pill color)
	stage: PipelineStage; // §4 — current position on the Read→…→Reply timeline
	stageProgress: StageStep[]; // §4 — per-stage status for the horizontal timeline
	workers: TaskWorker[]; // §5 — active/assigned workers as Role + Identity
	routing: RoutingGraph; // §5 — node graph data (no coordinates)
	block: BlockInfo | null; // present iff state === 'Waiting'
	proof: Proof | null; // present from the Check stage onward
	result: ResultInfo | null; // present from the Delivering stage onward
	isDestructive: boolean; // gates the double-confirm Approve flow (model §8.I)
	startedAt: string | null; // ISO
	endedAt: string | null; // ISO
	ticketId: string | null;
}
```

---

## 3. Task states (the 8) + mapping from the internal FSM

`TaskState` drives the pill/card status color and the high-level "what is Sully
doing" header.

```ts
export type TaskState =
	| 'Reading'
	| 'Planning'
	| 'Working'
	| 'Reviewing'
	| 'Waiting'
	| 'Delivering'
	| 'Complete'
	| 'Stopped'
	| 'Failed';
```

| Work Surface `state` | internal `JobStatus`                                                     | notes                                                 |
| -------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| **Reading**          | `proposed`, `classified`                                                 | parsing intent, classifying tier                      |
| **Planning**         | `gated`, `held` (non-operator), `decided`                                | workspace setup, team assembly                        |
| **Waiting**          | `held` w/ operator block, OR a pending **proposal** awaiting tap-confirm | populate `block`                                      |
| **Working**          | `dispatched`, `working`                                                  | worker actively running tools                         |
| **Reviewing**        | `done` AND `verification_state ∈ {pending,running}`                      | Go/No-Go running post-worker                          |
| **Delivering**       | `verified`, or `done` w/ verification settled, pre-synthesis             | synthesis in progress, sandbox closing                |
| **Complete**         | `synthesized`                                                            | terminal success                                      |
| **Stopped**          | `aborted`                                                                | halted by `/kill`                                     |
| **Failed**           | `failed` (or `retry` exhausted)                                          | terminal failure — render w/ failure banner + `proof` |

> The model doc lists 8 states (no explicit "Failed"). We add **Failed** because the
> FSM has a real `failed` sink and the UI must not show a failure as "Complete." It
> renders like Complete (Expanded card, `View Result`/diagnostics) but with a red
> banner + the failure reason from `proof`. **Locked 2026-06-06: distinct `Failed` state** (§11).

---

## 4. Pipeline stages (the 6) + the timeline

`stage` is the current marker; `stageProgress` is the full horizontal timeline
(`Read → Research → Build → Check → Approve → Reply`) with per-stage status.

```ts
export type PipelineStage = 'Read' | 'Research' | 'Build' | 'Check' | 'Approve' | 'Reply';

export interface StageStep {
	stage: PipelineStage;
	status: 'done' | 'active' | 'pending' | 'skipped';
	startedAt?: string; // ISO — for the Expanded "phase times"
	durationMs?: number; // for the Expanded checklist
}
```

**Derivation (server-side), grounded in `JobStatus` + `current_activity`:**

| `stage`    | when                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| `Read`     | `proposed`, `classified`                                                                |
| `Research` | `decided`/early `working` AND a Research-role worker is active **[future: multi-role]** |
| `Build`    | `dispatched`, `working` (default single-worker stage)                                   |
| `Check`    | `done` with verification running                                                        |
| `Approve`  | `state === 'Waiting'` (operator gate) — may occur mid-pipeline                          |
| `Reply`    | `verified`/synthesizing/`synthesized`                                                   |

> v1 reality: a single Build worker, so the timeline lights `Read → Build → Check →
Reply` and `Research` is marked `skipped` unless a research worker is dispatched.
> `Approve` only appears when a gate fires. The frontend renders all 6 always;
> backend sets `skipped` for stages that don't occur this run.

---

## 5. Worker model — Role + Identity + the graph

Per model §3: **Roles** are stable interfaces; **Identities** are swappable engines.

```ts
export type WorkerRole = 'Research' | 'Build' | 'Review' | 'Memory' | 'Vision' | 'Voice';
export type WorkerStatus = 'queued' | 'active' | 'done' | 'failed' | 'idle';

export interface TaskWorker {
	identity: string; // canonical worker id, e.g. 'claude-code'
	shortCode: string; // 'CC' — dimmed in Compact, clear in Expanded (model §9)
	display: string; // 'Claude Code' — Expanded registry
	role: WorkerRole;
	status: WorkerStatus;
	step?: string; // live progress line (PendingJob.current_activity / heartbeat)
	lastFile?: string;
	slot?: string; // worktree slot, e.g. 'project-miru/w1' — targets /kill
}

export interface RoutingGraph {
	nodes: GraphNode[]; // always a 'core' (Sully) node + one per worker
	edges: GraphEdge[]; // payload routing; frontend animates `active` edges
}
export interface GraphNode {
	id: string;
	kind: 'core' | 'worker';
	role?: WorkerRole;
	status: WorkerStatus;
}
export interface GraphEdge {
	from: string;
	to: string;
	active: boolean;
}
```

**Identity label table** (the existing `workerLabel` only maps CC/AGY — **must be
extended** to the full roster):

| worker id     | shortCode | display        | typical roles            |
| ------------- | --------- | -------------- | ------------------------ |
| `claude-code` | `CC`      | Claude Code    | Build, Research          |
| `agy`         | `AGY`     | Antigravity    | Build                    |
| `cdx`         | `CDX`     | Codex          | Build, Review            |
| `gmi`         | `GMI`     | Gemini (Aider) | Build                    |
| `dpsk`        | `DPSK`    | DeepSeek       | Review (auto-verify)     |
| `gemini`      | `AGY`     | Antigravity\*  | \*legacy alias for `agy` |
| `perplexity`  | `PPX`     | Perplexity     | Research                 |

> **[future]** A task's `workers[]` may hold several entries once team-assembly
> (model §2.3) lands. v1: one `Build` worker (the dispatched one), plus a `Review`
> worker entry once DeepSeek auto-verify (bucket B #9) is wired.

---

## 6. Proof / verification model

Maps from `PendingJob.verification_state` / `verification_ref` / `verification_evidence`,
populated by the Go/No-Go path (`verifyPoll.ts` → `completionClose.ts`).

```ts
export interface Proof {
	verdict: 'go' | 'no-go' | 'pending' | 'skipped';
	score?: number; // 0–100 confidence, optional
	checks: ProofCheck[]; // the Expanded "automated test reports"
	evidenceRef?: string; // verification_ref — commit sha / journal link
}
export interface ProofCheck {
	name: string; // 'commit present', 'build', 'vitest'
	status: 'pass' | 'fail' | 'pending' | 'skip';
	detail?: string;
}
```

> v1 minimal: a single check `{ name: 'commit present', status }` from the deterministic
> Go/No-Go (Phase 5a already verifies a real commit). Richer checks (lint, tests, the
> DeepSeek reasoning pass) append as they're wired.

---

## 7. Endpoints

| Method | Path                                       | Purpose                                                   | Status                                           |
| ------ | ------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------ |
| `GET`  | `/api/chat/dispatch/active`                | list active + recent tasks (the surface feed)             | **NEW** (thin — wraps `getJobsForThread`)        |
| `GET`  | `/api/chat/dispatch/[trace]`               | full `WorkSurfaceTask` + raw `activity[]` for diagnostics | **EXTEND** (today returns raw `{job, activity}`) |
| `GET`  | `/api/chat/dispatch/stream`                | SSE: live task projection deltas                          | **EXISTS** — extend payload (§8)                 |
| `POST` | `/api/chat/dispatch/[trace]/stop`          | stop a running task                                       | **NEW** — proxies kernel `/kill`                 |
| `POST` | `/api/chat/dispatch/[trace]/approve`       | approve a `Waiting` task (double-confirm for destructive) | **NEW** (or reuse `/api/chat/approve`)           |
| `GET`  | `/api/chat/dispatch/[trace]/files`         | list result files                                         | **NEW** — pairs w/ the merged file-server        |
| `GET`  | `/api/workspace/[project]/files/[...path]` | fetch one result file (`View Result`)                     | **MERGED ✅**                                    |

### `GET /api/chat/dispatch/[trace]` → `{ task, activity }`

```jsonc
{
	"task": {
		/* WorkSurfaceTask, §2 */
	},
	"activity": [
		/* ActivityEvent[] — Expanded diagnostics only */
	]
}
```

### `GET /api/chat/dispatch/active` → `{ tasks }`

```jsonc
{
	"tasks": [
		/* WorkSurfaceTask[], newest first, active before terminal */
	]
}
```

### `POST /api/chat/dispatch/[trace]/stop` → `{ stopped, killedPid, slot }`

- Body: `{}`. Auth: **same-origin only** (reject `tailscale-funnel-request` header,
  matching `dispatch/confirm`).
- Mechanism: HMAC-sign `{ trace_id }` (`x-w4-hmac`, secret `W4_LISTENER_HMAC_SECRET`)
  and `POST` to the listener `/kill` (`:19100`) — the route **already exists**
  (force-kills the lease PID via `SIGTERM`, releases the slot; the Console UI already
  calls it). On a pre-PID-stamp race, LOS-149 makes the spawn cancel cleanly.

```jsonc
{ "stopped": true, "killedPid": 48213, "slot": "project-miru/w1" }
```

- The task then projects as `state: 'Stopped'` (internal `aborted`).

### `POST /api/chat/dispatch/[trace]/approve` → `{ approved }`

- Body: `{ "confirmToken"?: string }`. For **destructive** tasks the first call
  returns `{ approved:false, requiresConfirm:true, confirmToken }`; the second call
  with that token executes (model §8.I two-step flow). Non-destructive: single call.
- Reject public-Funnel callers.

### `GET /api/chat/dispatch/[trace]/files` → `{ project, files }`

```jsonc
{
	"project": "sully-workspace",
	"files": [{ "path": "demo/index.html", "size": 1843, "type": "text/html", "mtime": "..." }]
}
```

- Confined to the task's workspace (reuse `assertWorkspaceReal` from `workspace.ts`).
  Needs a new `listWorkspaceTree(project)` helper beside `resolveWorkspaceFile`.
- Each `path` is fetchable via the merged single-file endpoint.

---

## 8. SSE event model (`/api/chat/dispatch/stream`)

The stream already runs (SSE, `last-event-id` resume). For the Work Surface it should
emit, per task, a compact delta whenever `state` / `stage` / a worker `status` /
`block` changes:

```jsonc
// event: task
{
	"traceId": "...",
	"patch": {
		"state": "Reviewing",
		"stage": "Check",
		"proof": { "verdict": "pending", "checks": [] }
	}
}
```

The frontend merges `patch` into its held `WorkSurfaceTask`. Full object via the GET;
stream carries deltas only.

> **Decision:** today the stream/`[trace]` route deliberately **hides** internal
> pipeline events (`gate_evaluated`, `synthesis_completed`) from the UI (the "P2 leak
> fix"). The Work Surface needs _stage transitions_, which are partly those internal
> events. Resolution: expose the **projected `state`/`stage`**, never the raw internal
> event names or vendor logs (consistent with model §4.4 "hide implementation
> details"). The projection is the privacy boundary.

---

## 9. Actions — how the buttons bind (model §8)

| Button          | Appears when                                                                | Calls                                       | Confirm                                |
| --------------- | --------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------- |
| **Approve**     | `state==='Waiting'`, `block.kind==='approval'`                              | `POST …/approve`                            | two-step if `isDestructive`            |
| **Stop Task**   | `state ∈ {Working, Reviewing, Planning}` (Expanded), or `Waiting` (Compact) | `POST …/stop`                               | inline `Confirm stopping active task?` |
| **View Result** | `state ∈ {Complete, Failed}`                                                | `GET …/files` then file endpoint            | —                                      |
| **Start Over**  | `state==='Stopped'`                                                         | re-dispatch (existing propose/confirm flow) | —                                      |

All buttons `event.stopPropagation()` (don't toggle the card). Destructive Approve
shows the exact `block.targetPath` (model §8.III — never hide the reason).

---

## 10. Build map — exists vs. new

**Reuse as-is:** `dispatchJobs.ts` FSM · `getJob`/`getJobsForThread` · SSE stream
plumbing · `/api/workspace/.../files/[...path]` (merged) · kernel `/kill` route ·
`assertWorkspaceReal`.

**Backend to build:**

1. `projectTask(job, activity, verification): WorkSurfaceTask` — the mapper (§3–6). _Core._
2. Extend `GET /api/chat/dispatch/[trace]` to return `{ task, activity }`.
3. `GET /api/chat/dispatch/active`.
4. `POST /api/chat/dispatch/[trace]/stop` (HMAC proxy → `/kill`).
5. `POST /api/chat/dispatch/[trace]/approve` (+ destructive two-step).
6. `GET /api/chat/dispatch/[trace]/files` + `listWorkspaceTree()` in `workspace.ts`.
7. Extend SSE payload to emit task deltas (§8).
8. Extend the identity label map to the full roster (§5) — currently CC/AGY only.
9. Surface `proof` from `verification_*` columns (today held server-side).

**Frontend to build:** the three card footprints (Pill/Compact/Expanded) reading
`WorkSurfaceTask`; the SVG node graph from `routing`; the timeline from
`stageProgress`; the action buttons per §9.

---

## 11. Decisions (locked 2026-06-06, operator-approved)

1. **`Failed` is a distinct state.** Failures render as their own card (Expanded,
   `View Result`/diagnostics) with a **red banner** + the failure reason from `proof`
   — never shown as "Complete." `TaskState` keeps `'Failed'` (§3).
2. **v1 = single `Build` worker + the `Review` (DeepSeek) worker.** No full
   team-assembly / multi-node graph in v1 — that's v2. The `workers[]` array, roles,
   and `RoutingGraph` are still defined now so v2 is additive (the graph just renders
   1–2 nodes in v1). The DeepSeek auto-verify worker (bucket B #9) is the second node
   when wired.
3. **Wire `isDestructive` + the two-step Approve field now; land the live flow with
   the first destructive-capable task.** The frontend builds the double-confirm
   binding (§9) against the field immediately; the backend sets `isDestructive=false`
   until a task type can actually do something destructive, then flips it on.
