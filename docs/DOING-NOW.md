# Sully — Doing Now

> _Last updated: 2026-06-04 · companion: see [CURRENT-STATE.md](CURRENT-STATE.md) · what's next: [PLAN.md](PLAN.md)_
>
> What's actively in flight right now, grounded in git history + the live journal.

## Active focus (operator's stated priorities)

| Project                       | Status        | Note                                                                       |
| ----------------------------- | ------------- | -------------------------------------------------------------------------- |
| **LogueOS-Companion (Sully)** | 🛠️ **Active** | The current build focus. 178 commits in the last 14 days.                  |
| **Miru**                      | ⏸️ Paused     | Operator's "first big project," coming back to it after Companion settles. |
| **Nasdoom**                   | 🔭 Future     | Frontend work pending; backend reported done. Dormant (0 commits/14d).     |

## Just shipped (this session, 2026-06-03 → 06-04)

- **Task-first v1 verification layer COMPLETE + proven live (PR #7–#14, all merged + deployed).** The full "verify before she speaks / never silently mutate / classify before answering" stack:
  - **Plan A Go/No-Go** (`verifyPoll.ts`, deterministic evidence at completion) + **Fact-Gate** (`factGate.ts`, source-or-confirm on conversational facts) + **Plan B adversary** (`adversary.ts`, stakes-gated, concerns never facts). PR #7–#9.
  - **Plan C — active-task mutation** (`mutation_gate.ts` + R1 substrate): while a task RUNS, a work-intent turn never silently injects/drops — it asks (hold/sibling); conversation flows. PR #10/#11. + the **E2 over-gate fix** (opinion questions mentioning the running work stay conversational). PR #14.
  - **Plan D — classify-before-answer** (`turn_decision.ts` `resolveTurnDecision`/`applyTurnDecision` + `needsFullReply`): the deterministic decision now gates the reply — work turns short-circuit to the proposal (no full pre-answer), chat streams normally. CLI teacher gateBlock dropped. PR #12 (substrate) + #13 (reorder).
  - **Two live behavior audits** (`data/sully_behavior_audit_2026-06-04/`): 10/10 routing/safety both times; D2 re-run proved the fix — work-turn latency **37,409ms → 84ms**, no full pre-answer, R2 row pristine. **All 8 acceptance criteria now have live evidence.** Sully rated "ready for a real small-project test."
- **Dispatch Task-card + one-tap confirm buttons (PR #5 + #6 — MERGED, LIVE, verified in production).** The hand-off is now ONE seamless card: while CC works it shows a calm pulse + a friendly status line; on finish it collapses to `✓ CC handled this · Ns` flush above Sully's plain-English answer — **no more stuck `claude-code working · 39:53` timer, no raw `synthesis_completed {json}` leaking** (root cause: jobs end at `synthesized`, which the terminal allow-list missed). Ask-before-dispatch got brand-styled **Run it / Not now** fuchsia pills (match `DispatchChips`). Proven end-to-end live: operator said "audit the companion repo" → tapped **Run it** → CC ran a real audit → Sully synthesized the result. New `src/lib/dispatchActivityView.ts`, reworked `WorkingBubble.svelte` / `dispatchStream.svelte.ts`, new `api/chat/dispatch/confirm/+server.ts`.
- **Real Sully synthesis (Phase 3, PR #4).** Finished worker results come back as a plain-English summary in Sully's voice (Haiku), not raw output; best-effort with raw fallback. + a daily-cap over-count fix (self-handled turns were counting as dispatches).
- **Ask-before-dispatch (Phase 2, PR #3).** Sully no longer needs `@cc`/`@agy`: she PROPOSES work and dispatches only on confirm (tap a button or say "yes"). Pure `decide()` (Talk/Ask/Dispatch) + an anti-confabulation guardrail (she can't claim work she never dispatched).
- **Routing scorecard + close-the-loops (PR #2).** Pure `decide()` graded by a **hard CI scorecard gate** (95.6%); classifier tier persisted on the Task; completions route to the live thread + are idempotent; stale-job reaper.

## Earlier (2026-06-02 → 06-03)

- **Native iOS push (APNs)** — built server-side, fixed a 4-build signing saga (vanished cert → stable-key + one-time cert reset) AND the real root cause (Capacitor 8 drops the AppDelegate token-forwarding), shipped on **build 15**, verified end-to-end (test push hit the lock screen). `8de7cde…a245f93`
- **Read-aloud / Talkback fixed** — iOS audio-unlock (play through the shared element) + trailing-silence pad (iOS clips WAV ends) + self-heal when the local TTS GPU faults. `513d39a, 9a11aea, ccb0788`
- **Cloud Emma is now primary** for talkback + voice (off-GPU, ~0.6 s, no CUDA-fault risk; local Chatterbox is the fall-forward). One env flip: `VOICE_TTS_PROVIDER=elevenlabs`.
- **Task-first Phase 1** — Task object + forensic journal + `turn_replay.ts` reader API. `c8f6bc1` (+ gate tightening `be62344`).
- **Full app audit + quick-wins batch** — 7-dimension evidence-based audit; 9 quick wins landed (index bug, type error, wrong-thread bug, CI gate, hotkey, dead-code, APNs cache, …). `11f466e`
- **Web tools** wired into text + voice via Ollama Pro. `78dfeb9`

## Open threads (in progress, not finished)

1. **"Today's Ops" dashboard → now the NEXT milestone (Phase 5: workspace + write-tool).** The **first task-first real-world test project** + the recommended next build now that v1 is done (Sully is "ready for a real small-project test"; the operator literally requested this in live-audit prompt C2). Data-sources design: `data/peer_reviews/2026-06-02_todays-ops-data-sources_design.md`. **The blocker is known:** Sully has **no write/mkdir tool** + no workspace container, so she can't create the dashboard folder (gap audit: `data/peer_reviews/2026-06-03_sully-vision-gap-audit.md`). **Plan: brainstorm/scope the workspace + write-tool slice first** (like Plan D), then build. (Cheap precursor recommended: one live confirm on a NO-OP brief to observe the Go/No-Go + adversary + synthesis stages end-to-end — the last unobserved part of v1.)

2. **Task-first v1 — ✅ COMPLETE + proven live 2026-06-04 (Plans A–D + Fact-Gate, all merged/deployed).** Verify-before-she-speaks (Plan A Go/No-Go `verifyPoll.ts` + Fact-Gate `factGate.ts` + Plan B adversary `adversary.ts`), never-silently-mutate-a-running-task (Plan C `mutation_gate.ts`), classify-before-answer (Plan D `turn_decision.ts`). Spec: `docs/superpowers/specs/2026-06-04-sully-task-first-state-machine-v1-design.md`. **All 8 acceptance criteria proven by two live audits** (`data/sully_behavior_audit_2026-06-04/`). _Remaining small follow-ups (not urgent): the Go/No-Go `verification_poll` + adversary + synthesis stages aren't yet observed LIVE (only on a completed dispatched worker turn — covered by unit tests); legacy `/api/chat` reorder still deferred._

3. **The post-audit refactor** — quick wins done; the higher-effort items (legacy `/api/chat` handler migration, shared DB layer, voice consolidation) are queued behind the CI gate. (PLAN.md.)

## Decisions waiting on you

- **Legacy Talkback** — retire the old in-composer Talkback now that realtime voice is primary?
- **Phase 5 shape** — when we scope the workspace + write-tool slice: where does Sully's workspace live, and how locked-down is the write tool? (Brainstorm pending.)

> _Resolved this session:_ **gate authority** — settled as **propose-then-confirm** (ask-before-dispatch + tap buttons), not silent auto-dispatch: Sully's judgment now drives a _proposal_, the operator confirms. **Dispatch Task-card surface**: shipped. **Next-milestone order**: settled — Task-first v1 verification (Plans A–D) shipped + proven live first; **workspace + write-tool (Phase 5) is next**, unlocking "Today's Ops".
