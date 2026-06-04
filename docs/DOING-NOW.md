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

1. **"Today's Ops" dashboard** — the **first task-first real-world test project**. Data-sources design written: `data/peer_reviews/2026-06-02_todays-ops-data-sources_design.md`. **Still blocked, and we now know the real blocker:** Sully has **no write/mkdir tool** + no workspace container, so she physically can't create the dashboard folder (the gap audit confirmed this — `data/peer_reviews/2026-06-03_sully-vision-gap-audit.md`). Needs the **workspace + write-tool slice** before it can run.

2. **Verification stage (Task-first v1) — ✅ SHIPPED 2026-06-04 (Plan A + Fact-Gate + Plan B, all live).** Deterministic Go/No-Go at completion (`verifyPoll.ts`), the conversational Fact-Gate (`factGate.ts` — source-or-confirm), and the stakes-gated adversary (`adversary.ts` — concerns, never facts). Spec: `docs/superpowers/specs/2026-06-04-sully-task-first-state-machine-v1-design.md`. **Next v1: Plan C — task mutation** (active-task conversation: attach / sibling / conversational, never silently mutate running work), then **Plan D — classify-before-answer reorder** (the streamed-reply/contradiction fix). 5 of 8 acceptance tests proven.

3. **The post-audit refactor** — quick wins done; the higher-effort items (legacy `/api/chat` handler migration, shared DB layer, voice consolidation) are queued behind the CI gate. (PLAN.md.)

## Decisions waiting on you

- **Legacy Talkback** — retire the old in-composer Talkback now that realtime voice is primary?
- **Next milestone order** — verification stage (small, makes Sully trustworthy) vs. the workspace/write-tool slice (unlocks "Today's Ops")? Both are teed up.

> _Resolved this session:_ **gate authority** — settled as **propose-then-confirm** (ask-before-dispatch + tap buttons), not silent auto-dispatch: Sully's judgment now drives a _proposal_, the operator confirms. **Dispatch Task-card surface** (was Phase-3 "TaskCard"): shipped.
