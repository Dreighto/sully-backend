# CDX Frontend Audit: Sully Work Surface

Repo audited: `/home/dreighto/dev/LogueOS-Companion`  
Date: 2026-06-06  
Mode: read-only audit, no repo changes

## 1. Animation

### Problem
The current graph motion is phase-colored decoration, not event-driven system telemetry. The operator complaint about "the square that comes in from the left" is accurate: packets are anonymous looping rectangles with no dispatch/result meaning and no clear arrival beat.

### Evidence
- `WorkGraph.svelte` derives motion entirely from `task.stage`, not from real events: `activeMotionType` is a stage switch at [src/lib/components/WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:80), and packet count/timing are hard-coded by phase at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:168). `GraphEdge` only carries `active: boolean`, so there is no event payload to animate against at [src/lib/types/workSurface.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/types/workSurface.ts:101).
- The moving packet is literally a generic square: the graph renders `<rect>` payloads at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:263), with infinite glide loops at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:425). That is the "square from the left."
- The "land" response is unsynchronized noise. Core pulse and ripple run forever at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:467) and [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:474), so packet arrivals never cause a distinct beat.
- Idle is never quiet. Worker orbital rings rotate continuously at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:345), core fields breathe continuously at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:367), and primary route sweeps loop continuously at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:404).
- The single-worker research state also forces a permanently active mystery input line from off-screen at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:210) and renders it unconditionally at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:239). That reads as story noise, not telemetry.
- Directionality is unclear because the seed routes are mostly only `worker -> core`, regardless of whether the system should be dispatching out or receiving back: see seeds at [src/lib/data/workSurfaceSeed.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/data/workSurfaceSeed.ts:34), [workSurfaceSeed.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/data/workSurfaceSeed.ts:74), [workSurfaceSeed.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/data/workSurfaceSeed.ts:114), [workSurfaceSeed.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/data/workSurfaceSeed.ts:154), and [workSurfaceSeed.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/data/workSurfaceSeed.ts:194).
- The approved v4 mock intended semantic motion by phase, not random motion. It used distinct payload assets, per-phase route behavior, and synchronized arrival ripples: packet payload selection at [docs/design/.../real_assets_v4_final.js](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.js:476), worker/system/task icons at [real_assets_v4_final.js](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.js:547), building arrival ripples at [real_assets_v4_final.css](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.css:614), verifying arrival logic at [real_assets_v4_final.css](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.css:655), and stop/complete/fail settling at [real_assets_v4_final.css](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.css:685).

### Prioritized Fix
1. Add an event model to the surface contract. `routing.edges.active` is not enough. Add per-surface event frames like `dispatch_started`, `dispatch_arrived`, `result_started`, `result_arrived`, `verify_started`, `verify_arrived`, each with `from`, `to`, `eventType`, `eventId`, and timestamp.
2. Change the motion language to this:
   - Dispatch: one outbound pulse `core -> worker`, with a visible land beat on the worker node.
   - Result: one inbound packet `worker -> core`, with a visible land beat on the core.
   - Verify: a deliberate inspect packet plus a short hold, not a permanent loop.
   - Idle: no sweep, no packet motion, no breathing except a very slow core ambient.
3. Remove always-on decorative loops from worker rings, route sweeps, and task ripples unless there is an active event on that route.
4. Replace the hard-coded off-screen research edge with a real "memory/context attached" event or delete it.
5. Use packet icons, not rectangles, so the operator can read payload type at a glance.

## 2. Asset-Fidelity Gap vs Approved Mock

### Problem
The lift preserved the rough card structure but dropped a large part of the approved mock's real assets and framing. The result is recognizably "from the mock" but materially less legible and less polished.

### Evidence
- Worker, system, and task icons were replaced with placeholder circles in the lift:
  - Current placeholders: worker at [src/lib/components/WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:277), system at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:297), task at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:321).
  - Mock real assets: worker/system/task symbols at [docs/design/.../real_assets_v4_final.html](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.html:19), [real_assets_v4_final.html](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.html:44), and usage in JS at [real_assets_v4_final.js](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.js:553), [real_assets_v4_final.js](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.js:608), [real_assets_v4_final.js](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.js:668).
- Payload assets were also dropped. The mock defines `payload-researching`, `payload-building`, and `payload-verifying` at [real_assets_v4_final.html](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.html:66). The lift uses only a rectangle at [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:263).
- The header icon became static. The mock swaps per-preset header icons at [real_assets_v4_final.js](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.js:731). The lift hard-codes `Send` in compact and expanded headers at [src/lib/components/WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:80) and [WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:133).
- The mock includes an operator banner with the "Next:" line in the compact card at [real_assets_v4_final.html](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.html:271), populated from preset data like [real_assets_v4_final.js](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.js:15). The lift has no equivalent banner in `WorkSurfaceCard.svelte`.
- The mock includes contextual framing around the card:
  - User prompt bubble at [real_assets_v4_final.html](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.html:224).
  - System-status bubble under the card at [real_assets_v4_final.html](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.html:344).
  - JS population from `prompt` and `systemStatus` at [real_assets_v4_final.js](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.js:739).
  - The lift only shows `task.title` and `Now: {firstWorkerStep}` at [WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:83) and [WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:100).
- The preview page lost the approved preset descriptions. The mock has titled preset buttons with descriptions at [real_assets_v4_final.html](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.html:113) and styling at [real_assets_v4_final.css](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.css:69). The current preview just transforms seed keys into labels at [src/routes/work-surface-preview/+page.svelte](/home/dreighto/dev/LogueOS-Companion/src/routes/work-surface-preview/+page.svelte:51).
- The motion legend is present in the approved mock at [real_assets_v4_final.html](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.html:166) with styles at [real_assets_v4_final.css](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.css:105). The lift has no legend.
- The motion-intensity control is present in the mock at [real_assets_v4_final.html](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.html:178) and implemented by intensity classes at [real_assets_v4_final.css](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.css:720). The lift has no equivalent.
- The mock also has a monochrome icon toggle at [real_assets_v4_final.html](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.html:157) and icon-color override rules at [real_assets_v4_final.css](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.css:327). The lift currently has neither.

### Prioritized Fix
1. Restore the SVG symbol pipeline first: worker icons, system icons, task icon, and payload assets.
2. Restore the compact-card operator banner with the "Next:" line. This is high-value context the operator can scan instantly.
3. Restore dynamic header icons so the card state is not visually flattened to one generic send symbol.
4. Restore the preview controls that were part of the approved review artifact: preset descriptions, motion legend, motion intensity, and monochrome toggle. Those are not necessarily live-product UI, but they are important fidelity and review tooling.
5. Decide what "contextual framing" becomes in product. The mock used prompt + system bubble around the card; the cockpit version should keep that information, but likely attach it to the conversation spine and the dock row rather than repeating mock chat chrome literally.

## 3. Consistency for the Companion -> Cockpit Reframe

### Problem
The current visual system still treats the work surface as an extension of Sully's companion persona. That works for chat and talkback, but it conflicts with the stated cockpit goal: legible, scan-first, operator-grade telemetry.

### Evidence
- Magenta is still being used as a functional "active" color across the surface instead of as a restrained brand accent:
  - Brand token is globally dominant at [src/app.css](/home/dreighto/dev/LogueOS-Companion/src/app.css:12), [app.css](/home/dreighto/dev/LogueOS-Companion/src/app.css:18), [app.css](/home/dreighto/dev/LogueOS-Companion/src/app.css:38), and [app.css](/home/dreighto/dev/LogueOS-Companion/src/app.css:55).
  - Stage timeline active pill uses `var(--color-brand)` at [src/lib/components/StageTimeline.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/StageTimeline.svelte:65).
  - Phase checklist active dot uses brand at [src/lib/components/PhaseChecklist.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/PhaseChecklist.svelte:71).
  - Compact/expanded status pills for all active work states are brand-filled at [src/lib/components/WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:327).
  - Ownership pulse and default action buttons are also brand at [WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:357) and [WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:366).
  - Graph placeholders, packets, and task core are brand by default at [src/lib/components/WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:278), [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:322), [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:435), and [WorkGraph.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkGraph.svelte:455).
- The approved mock separated semantic motion colors from magenta. Research/build/verify/wait/done colors are distinct at [docs/design/.../real_assets_v4_final.css](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.css:18), while magenta only acted as a polish accent and some active-stage treatment.
- The surrounding chat surface still leads with companion-era atmosphere and persona:
  - Empty-state orb and language at [src/lib/components/MessageFeed.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/MessageFeed.svelte:107).
  - Thinking avatar and magenta dots at [MessageFeed.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/MessageFeed.svelte:302).
  - Tool-work avatar at [MessageFeed.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/MessageFeed.svelte:343).
  - Ambient purple/pink background wash at [src/routes/chat/+page.svelte](/home/dreighto/dev/LogueOS-Companion/src/routes/chat/+page.svelte:924).
  This is fine for chat, but the cockpit lane needs a less anthropomorphic frame.
- Spacing and surface treatment drift from the approved mock:
  - The mock graph viewport is framed and recessed at [real_assets_v4_final.css](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.css:258).
  - The lift graph slot is transparent and minimally framed at [src/lib/components/WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:349).
  - Mock status pills are semantic, outlined, and quieter at [real_assets_v4_final.css](/home/dreighto/dev/LogueOS-Companion/docs/design/Sully_Work_Surface/work_surface_reference/review_queue/demos/real_assets_v4_final/real_assets_v4_final.css:209); the lift turns active states into solid brand blocks at [WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:327).
- Mobile tap-target consistency is uneven. The broader app has a 44px icon-button rule at [src/app.css](/home/dreighto/dev/LogueOS-Companion/src/app.css:213) and message action buttons honor `min-h-[44px]` at [src/lib/components/MessageFeed.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/MessageFeed.svelte:171), but `WorkSurfaceCard` action buttons do not declare a 44px minimum at [src/lib/components/WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:366). The collapsed card height is also only 40px at [WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:243).

### Prioritized Fix
1. Re-scope magenta to identity, attention, and rare operator actions. Use semantic blues/cyans/purples/amber/green for live work states.
2. Split "chat persona chrome" from "cockpit chrome." Keep the avatar/orb in conversation and brainstorm lanes; remove it from the work-surface lane entirely.
3. Rework status pills, ownership banner, and graph viewport toward quieter, more operational treatments. The mock is a better baseline than the current lift here.
4. Standardize spacing and surface framing around a cockpit token set, not companion tokens.
5. Enforce 44px mobile hit targets for every tappable control on the work surface, including approve/stop/retry and any future expand/collapse affordances.

## 4. Concurrency Readiness

### Problem
The current work-surface model is still fundamentally "one card for one task," and the live chat path does not yet use the lifted `WorkSurfaceCard` at all. The backend can hold multiple jobs per thread, but the frontend treats concurrency as an exception rather than the normal operating mode.

### Evidence
- `WorkSurfaceCard` accepts one `task` and one `footprint` only at [src/lib/components/WorkSurfaceCard.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/WorkSurfaceCard.svelte:10). There is no dock list, no grouping, no selected/expanded surface id, and no compact row variant.
- The preview route is explicitly single-card: one selected seed key, one derived task, one card render at [src/routes/work-surface-preview/+page.svelte](/home/dreighto/dev/LogueOS-Companion/src/routes/work-surface-preview/+page.svelte:6) and [work-surface-preview/+page.svelte](/home/dreighto/dev/LogueOS-Companion/src/routes/work-surface-preview/+page.svelte:74).
- The live chat feed still renders system task messages as `WorkingBubble`, not `WorkSurfaceCard`, at [src/lib/components/MessageFeed.svelte](/home/dreighto/dev/LogueOS-Companion/src/lib/components/MessageFeed.svelte:125). That means task state is currently anchored to chronological message flow and scroll position, not a persistent cockpit rail.
- The current page keeps one big vertical message feed as the main spine at [src/routes/chat/+page.svelte](/home/dreighto/dev/LogueOS-Companion/src/routes/chat/+page.svelte:1001). If multiple rich surfaces were inserted inline, they would push conversation apart and bury active work below the fold.
- The server already has multi-job retrieval with `getJobsForThread(threadId, limit)` at [src/lib/server/dispatchJobs.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/server/dispatchJobs.ts:570), so the data source exists.
- But the "active task" helpers are single-winner queries:
  - `getActiveTaskForThread()` returns only the most recent non-terminal job at [src/lib/server/dispatchJobs.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/server/dispatchJobs.ts:101).
  - `getRunningTaskForThread()` returns only the most recent running job at [dispatchJobs.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/server/dispatchJobs.ts:120).
- The routing logic treats concurrency as a special-case branch. When a task is already running, Sully asks whether to hold or run as a sibling at [src/lib/server/chat/autonomous_dispatch.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/server/chat/autonomous_dispatch.ts:152). That is useful, but it is not yet the same as first-class multi-surface orchestration where attach/spawn is a normal turn-level action.
- `createDispatchStream(traceId)` opens one SSE stream per trace when rendered at [src/lib/chat/dispatchStream.svelte.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/chat/dispatchStream.svelte.ts:39) and starts it at [dispatchStream.svelte.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/chat/dispatchStream.svelte.ts:133). In a dock of many live surfaces, naive reuse would create too many long-lived EventSources.
- `WorkSurfaceTask` has a solid per-surface identity (`traceId`, `threadId`) at [src/lib/types/workSurface.ts](/home/dreighto/dev/LogueOS-Companion/src/lib/types/workSurface.ts:179), but it lacks metadata needed for a dock model: surface grouping (`running` / `needs-you` / `done`), last activity time, compact summary text, unread state, parent turn, and "attach to this surface" hints.

### Prioritized Fix
1. Make surface identity first-class. Use `traceId` as the stable `surfaceId` initially; add explicit metadata for `statusGroup`, `lastActivityAt`, `summaryLine`, `nextAction`, `needsAttention`, and `sourceTurnId`.
2. Add a dedicated `surfaces` store keyed by `surfaceId`, separate from message history. Conversation stays the spine; surfaces become a parallel state model.
3. Build a dock/rail:
   - `SurfaceDock` groups surfaces into `Running`, `Needs you`, and `Done`.
   - `SurfaceRow` is the compact always-visible row.
   - `SurfaceDetail` renders the full `WorkSurfaceCard` for the selected surface only.
4. Change turn handling to support both actions explicitly:
   - `spawn new surface`
   - `attach to existing surface`
   The current sibling/hold logic is the seed of this, but it needs to become deliberate UI and state, not only chat phrasing.
5. Do not open one SSE per visible history item. Use one of these:
   - A batched thread-level surface stream that multiplexes updates for all running traces.
   - Or list-poll for dock rows plus per-surface SSE only for the expanded surface and maybe a few visible running rows.

### Assessment: Would a Svelte store + dock component + per-surface reactive streams work?
Yes. That is the right direction.

Recommended shape:
- `surfacesStore`: `Map<surfaceId, SurfaceSummary>`
- `selectedSurfaceId`: one expanded surface at a time
- `surfaceEventsStore`: per-surface event queues for animation
- `surfaceDetailStore(surfaceId)`: lazily hydrated detailed task data

Main gotchas:
- Do not bind surface lifetime to message lifetime. A conversation can reference a surface long after the original system message scrolls away.
- Avoid `N` EventSources for `N` rows. Stream fan-out will become the scaling bottleneck before rendering does.
- Keep row updates cheap. Compact rows should not mount full SVG graphs.
- Preserve operator focus. Expanding a new surface should not yank scroll position in the chat spine.
- Decide attachment semantics early. A follow-up like "check whether scaffolding exists too" must either spawn a new `surfaceId` or attach to an existing one predictably.

## DO-FIRST 5

1. Replace phase-only animation with a real per-edge event model and make idle truly quiet.
2. Restore the real icon/payload asset pipeline and remove all graph placeholder circles and square packets.
3. Build the surface dock architecture now: `surfaces` store, grouped rail, one expanded detail surface, stable `surfaceId`.
4. Re-scope magenta to brand/attention only and move operational state colors to semantic hues.
5. Restore missing cockpit framing from the approved mock: dynamic header icon, operator "Next:" banner, and better contextual summaries.
