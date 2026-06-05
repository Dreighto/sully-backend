# Phase 1 — Discovery Report

**Audit:** Sully (LogueOS-Companion) behavior audit
**Date:** 2026-06-04
**Mode:** READ-ONLY (except this audit dir + one cleaned-up synthetic row in Phase 4-E)
**Auditor:** CC behavior-audit harness

---

## Live service (verified)

- **Sully app:** `http://localhost:18769` , base path `/companion` — **UP** (`/companion/chat` → HTTP 200).
- **Text turn endpoint:** `POST /companion/api/chat/sdk-stream` — present (`src/routes/api/chat/sdk-stream/+server.ts`). Returns AI-SDK UIMessage data stream (`text-delta` deltas).
- **Voice turn endpoint:** `POST /companion/api/chat/voice-reply` — present (`src/routes/api/chat/voice-reply/+server.ts`). Plain-text token stream + trailing `spokenSuffix`.
- **Dispatch confirm route:** `src/routes/api/chat/dispatch/confirm` — present (NEVER called in this audit).

## Source-of-truth DB (verified)

- `.env` line 7 overrides `LOGUEOS_MEMORY_DB_PATH=/home/dreighto/dev/LogueOS-Companion/data/companion.db`.
  (config.ts default would be the Orchestrator path; the .env override wins — confirmed by recency: companion.db written 17:49 today, and it contains the live chat threads.)
- **DB in use:** `/home/dreighto/dev/LogueOS-Companion/data/companion.db` (~408 KB). Read-only via `sqlite3`.
- Backups present (NOT the live DB): `companion.bak-*.db` (3 files). Ignored.
- Team-shared `logueos_memory.db` (Orchestrator) holds only 23 operator messages — NOT the rich Captain-voice source. Companion.db is the richest source.

### Key tables / journals (schemas confirmed)

| Table                      | Role                                              | Notes                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_messages` (339 rows) | conversation + proposals                          | cols incl. sender, message, status, thread_id, task_id, model, provider, tokens, latency_ms, error. **165 operator rows** = primary voice corpus. `pending_approval` status = a proposal (Ask). |
| `pending_jobs` (71 rows)   | Task FSM                                          | cols incl. trace_id, thread_id, status, category, classification_tier, classification_payload, verification_state, verification_evidence, ticket_id. trace_id == taskId.                        |
| `chat_activity`            | the forensic JOURNAL (`logTaskEvent` writes here) | cols: trace_id, action, target(JSON), timestamp. Event vocab in `src/lib/server/chatActivity.ts`.                                                                                               |

### FSM / routing facts learned from code (drive the expected-behavior column)

- **Tiers:** `chat | planning | deep | local` (`src/lib/server/phase_classifier.ts`). NOT a brainstorm/work binary.
- **Gate actions** (`src/lib/server/routing/decide.ts` + `chat/autonomous_dispatch.ts`): `Talk` / `Ask` / `Dispatch` (+ `RoutingAsk` / `Defer` from the Mutation Gate R2).
- **Only @cc/@agy/@gemini → immediate `Dispatch`.** Work intent without an @mention → **`Ask`** (a `gated` proposal, status `pending_approval` message, never auto-fired). This is exactly why every Category C test will be a PROPOSAL, not a dispatch.
- **Per-turn lifecycle:** every turn mints a Task → `proposeTask` (status `proposed`) → `task_proposed` event → `classifier_ran` event (tier) → reply → `gate_evaluated` event → `reply_persisted`. So `proposed`→`classified` is normal per-turn noise; a `gated` row + `pending_approval` message = a real proposal; `decided`+ = a dispatch.
- **Mutation Gate R2** (`src/lib/server/routing/mutation_gate.ts`): RUNNING_STATES = {decided, dispatched, working, retry}. When a running task exists on the thread, a new turn matching `WORK_INTENT_RE` → `RUNNING_WORK_INTENT` → posts a **RoutingAsk** ("hold it / run it separately") and NEVER mutates the running row. Non-work turn → `CONVERSATIONAL_ONLY` (Talk). This is what Category E exercises.
- **Verification + Adversary** (`src/lib/server/completionClose.ts`): `verification_poll` (Go/No-Go) and `adversary_reviewed` fire **only on a real worker completion** (`outcome==='done'`). Since this audit never confirms/dispatches, these will be **NOT_APPLICABLE** — see "Observability limits".

### Historical baseline in companion.db (read-only sanity)

- `chat_activity` action counts: gate_evaluated 57, task_proposed 56, classifier_ran 56, reply_persisted 55, synthesis_completed 5; **verification_poll 0, adversary_reviewed 0** (never emitted in prod — only worker turns produce them).
- gate_evaluated action distribution (current format): Talk 23, Ask 3, Dispatch 3, + 28 older-format rows (`forced/qualifies/path`).
- `dispatched:true` events: 4 (all historical @cc plumbing tests).
- **No `RoutingAsk` has ever fired in production** (R2 untested live → Category E live test is high-value).
- pending_jobs statuses: synthesized 30, proposed 27, done 7, failed 4, dispatched 1, working 1, aborted 1.

## Captain-voice corpora found (useful)

- **companion.db `chat_messages` (sender='operator', 165 rows)** — PRIMARY. Voice + text, post-deployment, in-persona. Used for Phase 2.
- `~/dev/training-corpora/companion-2026-06-01/{train,eval}.jsonl` + README/stats — 43 curated operator→Sully pairs already extracted from companion.db (p50 human msg 55 chars, p95 517). Good corroboration. Marked "NOT FOR COMMIT — operator's private chat history."
- `~/dev/training-corpora/blend-v1/blend-v2/companion-v2-best/...` — fine-tune blends (Captain + CC/CH register). Secondary.
- `data/peer_reviews/*.md` — GPT/CC architecture briefs on Sully's routing/task lifecycle (context, not voice).
- `data/ch_data_chat.zip` — a Claude-Chat export archive (not unpacked; not needed — companion.db already gives clean operator voice).

## Sources missing / not used

- No standalone ChatGPT/Gemini conversation exports found under `~/dev` (searched chat/conversation/export globints).
- No dedicated Sully app log file with per-turn routing decisions — the journal IS `chat_activity` in the DB (workers HTTP-POST `/api/chat/activity`). `LogueOS-Companion/logs/` exists but holds finetune logs, not turn logs.
- No "plot chat data" dataset by that name — the closest is the finetune corpora above.

## Observability limits (state up front, per instructions)

- **Observable per turn:** the operator row, Sully's reply text, the Task row in `pending_jobs` (status/tier/category), and the full journal in `chat_activity` (`task_proposed`, `classifier_ran`, `gate_evaluated` with action/reason/dispatched, `reply_persisted`).
- **NOT observable in this read-only run:** `verification_poll` (Go/No-Go) and `adversary_reviewed` — they only fire on a completed worker turn, which requires a confirmed dispatch we deliberately never do. → `verification_status = NOT_APPLICABLE`, `adversary_ran = false` for all tested prompts, by design, not by failure.
- `worker_dispatched` should be **false** for every test (no @mention, no confirm).
