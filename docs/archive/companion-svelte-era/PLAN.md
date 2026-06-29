# Sully — Plan / What's Next

> _Last updated: 2026-06-04 · state: [CURRENT-STATE.md](CURRENT-STATE.md) · in flight: [DOING-NOW.md](DOING-NOW.md)_
>
> The forward plan. Sourced from the 2026-06-02 audit synthesis + the task-first roadmap. Nothing here is started unless noted.

## Decisions

1. ✅ **RESOLVED — Sully's dispatch judgment.** Settled as **propose-then-confirm** (ask-before-dispatch, PR #3): `decide()` returns Talk/Ask/Dispatch; on Ask, Sully proposes and dispatches only on the operator's confirm (tap **Run it** or say "yes"). No silent auto-dispatch, no quota surprise — her judgment drives a _proposal_, not an unattended spawn. The dead injection guard now precedes `@cc`.
2. **Retire the legacy in-composer Talkback?** Still open. Realtime voice is primary; the old path duplicates playback/usage logic. Decide before consolidating the voice stack. _Refactor step #15._
3. **Next milestone order** — verification stage (small; makes Sully trustworthy) vs. the workspace/write-tool slice (unlocks "Today's Ops"). Both teed up.

## The refactor — remaining steps (quick wins already done in `11f466e`)

Sequenced low-risk-first, gated behind the now-live CI so the 134 tests catch regressions. Full detail + file:line: `data/peer_reviews/2026-06-02_companion-audit_findings.md`.

| Step | Effort | Risk | What                                                                                                                                                                                                                                                                           |
| ---- | ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 11   | M      | med  | **Migrate the rest of the legacy `/api/chat` handler** onto `persistAssistantTurn` so its replies get forensics + the journal + summary refresh (parity with streaming). The half-migrated handler is the source of the two highest-severity bugs. Do it one branch at a time. |
| 12   | M      | med  | **Gate authority** (decision #1) — make Sully's validated self-assessment decide on the CLI path; valueGate becomes a floor only for the cheap local path. Wire/arm or delete the dead injection guard.                                                                        |
| 13   | M      | med  | **Centralize the conversation window** (size + NEW-CONVERSATION reset-marker) into one shared helper used by all three paths — the streaming paths currently ignore the reset marker the legacy path honors.                                                                   |
| 14   | L      | med  | **One shared `db.ts`** owning a single connection (WAL + busy_timeout once) + all schema/migrations — replaces ~23 per-call open/close openers and kills the schema-duplication root cause. Do AFTER CI exists.                                                                |
| 15   | L      | med  | **Consolidate the two voice stacks** — one shared TTS-playback helper, one truthful usage-cap module, remove the dead `transcribe/stream` route. Gated on decision #2.                                                                                                         |

**Do NOT touch** (load-bearing, per the audit): the run-mode config matrix, the shared `chat_turn`/`stream_prepare`/`chat_prompt` extractions, the hot-window ordering, the documented Svelte-5 runes workarounds, the stable-signing-key injection, the tailnet fail-closed auth, the brakes-chain ordering.

## Task-first roadmap (the big arc)

Phases 1–3 shipped. The rest:

- ✅ **Phase 2 — gate before the answer (SHIPPED, PR #3).** `decide()` Talk/Ask/Dispatch; ask-before-dispatch emits the `classified`/`gated` states; proposals consumed/expired each turn.
- ✅ **Phase 3 — synthesis + the in-chat surface (SHIPPED, PR #4–#6).** Worker result → Sully synthesizes a plain-English summary (Haiku) → renders as the seamless morphing **Task card** (working pulse → `✓ CC handled this` strip). _Remaining sub-item:_ the **Dynamic Island** live-activity pill (reuses APNs) — not started.
- **Phase 4 — verification flow-back.** _Next._ Verify dispatched work (claimed PR/file/result actually exists) before it's "done" + before Sully's chat reply can contradict it; memory-writes triggered on Task transitions. The journal-aware QLoRA exporter lives here too.
- **Phase 5 — workspace + artifacts.** A sandboxed write/mkdir tool + workspace container + persisted Canvas — the slice that unblocks "Today's Ops." Largest greenfield.
- **companion-v3 retrain** — deferred until the journal has accumulated weeks of real Tasks (it's the data factory).

## Today's Ops dashboard (the first task-first test project)

Build a dashboard that answers "where did we leave off / what's next / roadmap" from **real sources** (git log, the task journal, Linear, a small projects registry) — never from stale config prose. Design: `data/peer_reviews/2026-06-02_todays-ops-data-sources_design.md`.

- **MVP (one sitting):** git-activity panel + projects registry + the 3-card `/ops` page. True-on-day-one from git alone.
- **Blocked on Phase 5 (write-tool/workspace)** — Sully physically can't create the folder yet (gap audit `data/peer_reviews/2026-06-03_sully-vision-gap-audit.md`). The dispatch path that would _run_ it as the test is now ready (propose→confirm, decision #1 resolved); the missing piece is the write capability.

## iOS / platform

- **Dynamic Island** live-activity (Phase-3 surface; reuses APNs). Separate larger build, not started.
- iOS keyboard-open delay on chat threads — open diagnostic (pre-existing task #28).

## Frontend polish (deferred, lower priority)

- Clean-&-premium visual pass; the new brand icon set + Auto-tier icon (awaiting the Moonlit Rabbit mark); the few a11y gaps the audit noted (`aria-pressed` on toggles, ImageLightbox keyboard handler).
