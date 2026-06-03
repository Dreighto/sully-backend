# Sully Routing Scorecard + Close-the-Loops — Design Spec

**Date:** 2026-06-03 · **Author:** CC (brainstorm with Captain) · **Status:** design, pending operator review → implementation plan
**Companion:** `~/dev/LogueOS-Companion` · **Gap audit this builds on:** `data/peer_reviews/2026-06-03_sully-vision-gap-audit.md`

---

## Plain-English summary

We're building two things, in order:

1. **Close the loops** — a handful of small fixes so every message Sully handles actually _finishes_ and gets _recorded properly_. Today most tasks quietly stall and worker results land in the wrong place, so there's no clean record to learn from.
2. **A routing scorecard** — an offline, run-on-command tool that grades Sully's "is this real work or just talk?" decisions against a hand-labeled set of examples, prints where she's wrong, and (because the gate is being measured) lets us safely fix the obvious misfires.

**What you get:** a command you can run anytime that says "Sully routes correctly X% of the time, here are the exact cases she gets wrong," fewer trigger-happy misfires immediately, and a labeled example set that doubles as the **seed for future QLoRA routing training**.

**What this is NOT (deferred):** the full "ask me first" behavior, the verification stage, real Sully-voiced synthesis, and the workspace/artifact layer. Those are Phases 2–5 in the gap audit.

---

## Decisions locked in this brainstorm

| Decision             | Choice                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Test style           | A **scorecard run on command** (not live labeling of real chats)                                                           |
| Test depth           | **Offline / pure-logic** first; capture the model-vote layer for offline scoring later                                     |
| What "correct" means | Grade against the **three-way ideal: Talk / Ask / Dispatch** (Ask = "should've checked with me first")                     |
| Measure vs fix       | **Measure AND fix the safe misfires** — every fix proven against the scorecard before shipping                             |
| Enforcement          | **Hard CI gate** — scorecard fails the build (blocks push/merge) on any locked-case regression or accuracy below threshold |

---

## Scope

**In scope:** Phase 0 (close-the-loops fixes) + Phase 1 (routing scorecard + the safe gate fixes).
**Out of scope (later phases):** the `Ask`/propose dispatch _behavior_ (we _measure_ against it now, we don't _build_ it yet), automatic verification, LLM synthesis of worker output, memory-as-a-lifecycle-stage, and the workspace/write-tool/artifacts layer.

---

## The approach

An **offline, pure-function scorecard.** Sully's fire-or-talk decision gets pulled into one pure function; we feed it a file of labeled example messages; it prints a report — _with no AI model call_. So it's instant, free, deterministic, and repeatable as often as you like.

Rejected alternative: running every example through the **live** Sully. More realistic, but it burns Max quota per run, gives different answers run-to-run, and can't be a clean pass/fail gate. We instead **capture** the model's own hidden vote (`SULLY_GATE`) into a fixture file and score that layer offline once enough accumulate.

---

## Phase 0 — Close the loops

These are prerequisites: the scorecard's value depends on the lifecycle recording its own decisions, and these are also the cheapest, highest-leverage fixes in the whole vision. (Touch-points are audit receipts; verify before editing.)

| #   | Fix                                                                                                                                                                                                           | Where (verify)                                                            | Acceptance                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 0.1 | Completion message reaches the live thread — empty `thread_id` misroutes it to `'default'`. Treat empty-string as missing **and** fix the dispatch write path so the job row persists the originating thread. | `activity/+server.ts:35` (`job?.thread_id ?? 'default'` → `               |                                                                                                                                                                     | 'default'`); audit `createJob`/`proposeTask`upsert at`dispatchJobs.ts:147-230` for thread_id clobber | A real `@cc` dispatch's "Done…" message appears in the thread you sent it from |
| 0.2 | Terminal-state race — a `completed` callback arriving after `aborted`/`failed` throws an illegal transition and silently skips closeout.                                                                      | `activity/+server.ts:124-139`                                             | Always attempt `closeOutTask` on a `completed` callback carrying `result_ref`, even if the FSM transition is rejected (or add `aborted/failed → synthesized` sinks) |
| 0.3 | Self-handled chat/voice turns die at `proposed` (27 of 41). Mark them `synthesized` when Sully's reply lands.                                                                                                 | `persistAssistantTurn` in `chat_turn.ts:119-163` → call `markSynthesized` | A pure-chat turn ends `synthesized` with `synthesis_message_id` set                                                                                                 |
| 0.4 | Classification never saved on the Task (`classification_tier` NULL on 100% of rows). Add `markClassified(traceId, tier, payload)` (proposed→classified is already legal) and write it.                        | `chat_turn.ts:94-110`; FSM at `dispatchJobs.ts:61`                        | `classification_tier` populated on ~100% of new rows                                                                                                                |
| 0.5 | Stale-job reaper — 2 jobs stuck `dispatched`/`working` ~2 days with no callback. Periodic sweep → `failed` + a "that task stalled, want me to retry?" message.                                                | new sweep; FSM `failed/retry` at `dispatchJobs.ts:66-68`                  | A worker that never calls back gets timed out and surfaced, not left hanging                                                                                        |
| 0.6 | **Runtime QA** — drive one real `@cc` dispatch end-to-end; confirm in-thread completion + `synthesized` status.                                                                                               | live                                                                      | Browser-verified per the operator's own rule (200-OK ≠ working)                                                                                                     |

Optional, cheap, supports the scorecard: emit the defined-but-unused journal events (`synthesis_started`, `failed`, `provider_fell_through`) from the existing failure paths so the journal records _why_, not just _what_.

---

## Phase 1 — The routing scorecard

### 1.1 One pure decision function

Extract a single pure function from the inline CLI/direct branches in `autonomous_dispatch.ts:113-149`:

```
decide({ userText, fromTool, recentTier, gateBlock? })
  → { action: 'Talk' | 'Ask' | 'Dispatch', worker?: 'claude-code' | 'gemini', reason: string }
```

`autonomous_dispatch.ts` becomes a thin caller of `decide()`. This is the unit the scorecard tests **and** the unit Sully calls in production — so test and behavior cannot drift. `decisionGate.ts` and `phase_classifier.ts` already have **zero imports** (pure, harness-ready). Note: today's code emits only Talk/Dispatch; `decide()` is structured for the 3-class output so the scorecard can grade against `Ask` even before the Ask _behavior_ (Phase 2) exists.

### 1.2 Labeled fixture set

`tests/fixtures/routing-cases.jsonl`, one row per example:

```
{"text": "wire up the companion app", "tier": "planning", "fromTool": false, "expected": "Talk", "note": "brainstorm chatter, not a work order"}
{"text": "fix the crash when I tap the orb", "tier": "chat", "fromTool": false, "expected": "Dispatch", "note": "clear bug + real target"}
{"text": "should we refactor stream_prepare?", "tier": "planning", "fromTool": false, "expected": "Ask", "note": "borderline — check first"}
{"text": "@cc update the model registry", "tier": "chat", "fromTool": false, "expected": "Dispatch", "note": "explicit @cc"}
```

**Sources:** (a) export the 28 real `gate_evaluated` journal turns from `companion.db` via sqlite; (b) the proven adversarial cases — false-positives (`"wire up the companion"`, `"update the kernel news"`, `"build a relationship with the console"`) and false-negatives (`"please go implement the login screen"`, `"fix the thing that crashes when I tap the orb"`); (c) a spread of realistic everyday phrasings.
**Starting size:** ~40–60 cases (enough to be meaningful, small enough for the Captain to review every label). Grows over time.

### 1.3 The report

A run-on-command script (e.g. `npm run routing:score`) that:

- runs every fixture through `ruleGate` + `valueGate` + `classifyTier` + `decide()`,
- prints **precision / recall + a 3×3 confusion matrix** (Talk/Ask/Dispatch),
- lists **the exact cases it got wrong** (text, expected, got, why),
- writes a dated MD report to `data/peer_reviews/` for hand-off.

Plus `tests/routing-scorecard.test.ts` (vitest, mirrors existing `tests/decision-gate.test.ts`) that **locks known cases as a regression gate** so a future change can't silently break them.

**Hard CI gate (operator decision 2026-06-03).** `tests/routing-scorecard.test.ts` runs inside the existing `.github/workflows/ci.yml` check+test step and **fails the build** when (a) any locked case regresses, OR (b) overall accuracy drops below a committed threshold. A failed routing scorecard blocks the push/merge — the same gate as `npm run check` + vitest today. The threshold is committed alongside the fixtures (start at the green baseline, ratchet up, never silently down).

### 1.4 Capture the model-vote layer (for later)

Start logging the real `SULLY_GATE` teacher self-assessment blocks (already produced on the CLI/Opus path) into a fixture file now — free. Score that layer offline once enough accumulate. **Not a blocker for Phase 1.**

---

## The safe fixes (each proven by the scorecard)

Apply only after the baseline scorecard exists; run it before _and_ after each change, ship only if the number improves and nothing regresses:

1. **Feed `classifyTier` into the gate** — require tier NOT in `{planning, deep}` for an autonomous (non-`@cc`) fire. This alone would have blocked the one real false-positive in the journal (a brainstorm). `phase_classifier.ts` already computes it every turn; `autonomous_dispatch.ts` just ignores it today.
2. **Tighten the regex false-positive surface** — demote bare `update/build/wire` unless paired with a code keyword or file path; add a brainstorm-phrase deny-list (`"trying to"`, `"thinking about"`, `"figure out"`). `decisionGate.ts:22-78`.

---

## Labels = your judgment + free training seed

- CC drafts the labeled set; **the Captain reviews it** (in the MD), because Talk-vs-Ask-vs-Dispatch is the operator's call about when Sully should interrupt him.
- The `expected` labels write into the same `quality_signal` / `verification_state` columns the journal is missing today (NULL on all rows). So a `(turn → tier → decision → reason → was-it-correct)` tuple finally exists in the DB, and the scorecard corpus **becomes the supervised seed set** for a future journal-aware QLoRA exporter (gap-audit Phase 4) — teaching routing/intent, not the voice-from-chat pairs the current `extract_companion_db_corpus.py` produces.

---

## Success criteria (done = all true)

- [ ] A real `@cc` dispatch completes and its result lands in the originating thread, status `synthesized` (Phase 0 proven live).
- [ ] `classification_tier` populated on new task rows.
- [ ] `npm run routing:score` runs offline in seconds and prints accuracy + confusion matrix + the wrong cases, and writes an MD report.
- [ ] A ≥40-case labeled fixture set, reviewed by the Captain.
- [ ] `tests/routing-scorecard.test.ts` runs in `ci.yml` as a **hard gate** — green on a clean build, and a forced regression (drop a locked case / lower accuracy) makes CI fail.
- [ ] The two safe gate fixes shipped, each shown to improve the scorecard with zero regressions.
- [ ] Labels persisted into `quality_signal`/`verification_state` so the corpus is QLoRA-ready.

---

## Risks & fail-closed notes

- **Behavior change is production-impacting for Sully.** The safe fixes alter live dispatch behavior — gated behind the scorecard (no change ships unless it improves the number). If a fix can't be shown safe, it doesn't ship.
- **Thin real data.** Only 1 real dispatch in the journal today, so early accuracy numbers ride mostly on hand-written cases — honest, but a small-sample caveat to state in the report (no silent over-claiming).
- **Don't touch** the load-bearing items the audit/handoff flag: `config.ts` run-mode matrix, the `chat_turn`/`stream_prepare`/`chat_prompt` extractions, hot-window ordering, the brakes-chain ordering, tailnet fail-closed auth.
- **`decide()` extraction must be behavior-preserving** for the Talk/Dispatch paths that exist today — verified by the regression test before any safe fix is layered on.
