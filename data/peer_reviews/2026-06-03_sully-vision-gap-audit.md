# Sully Workspace Vision — Gap Audit (vs. real app)

**Date:** 2026-06-03 · **Author:** CC · **Method:** 9-pillar parallel code/DB/service audit, every "current state" claim backed by a file:line, sqlite query, or service-status receipt. Source vision: "Sully Workspace Vision" (2026-06-02).

**Headline:** Sully's _skeleton_ matches the vision — every turn mints a Task, journals it, and voice+text share one spine (the hardest part, and it's provably done). But the lifecycle **dead-ends right after minting**: classification, verification, and synthesis are _scaffolded but never executed_, completions misroute to the wrong thread, and there is **no workspace/artifact layer at all**. Honest alignment: **~40%**.

---

## The three buckets

### ✅ Working / strong

- **Every turn (typed AND spoken) mints a Task + writes a journal — same code for both.** Voice and text share the lifecycle, memory, journal, thread, worker, and dispatch helper, confirmed in the DB. This is the vision's hardest requirement and it's met.
- **Dispatch is non-blocking** — `void maybeAutonomousDispatch(...)` is fire-and-forget; the chat polls every 3s; live worker progress streams over SSE. You can keep talking while a worker runs. (`sdk-stream/+server.ts:495-509`, `chat/+page.svelte:818`)

### 🟡 Built but "dark" (the code exists, just never fires)

- **Classification not saved on the Task.** Tier is computed + journaled, but never written to `pending_jobs.classification_tier` → **NULL on 100% of 41 rows.** No `markClassified` helper exists. (`chat_turn.ts:94-110`)
- **Verification never runs.** `markVerified()` has **ZERO callers** (grep-confirmed); `verification_state` NULL on all 41 rows. Worker output is trusted blindly. (`dispatchJobs.ts:286`)
- **Sully doesn't actually synthesize.** On completion, `closeOutTask` posts the worker's _own raw text_ inside a fixed `"Done. Here's what came back: ${text}"` template — no LLM call. (`activity/+server.ts:37-44`)
- **Completions misroute.** All 7 `done` jobs have **empty `thread_id`**, so the completion message goes to `'default'` and the operator never sees it. `synthesized` count = 0. (`activity/+server.ts:35`)
- **27 of 41 self-handled turns die silently at `proposed`** — pure-chat turns never close the arc. (`dispatchJobs.ts:9-10`)
- **Memory/learning is decoupled.** Finishing a task writes no lesson (`observation_emit` hard-returns `companion_mode`); `episodic_facts` is empty; `quality_signal` NULL on all 267 messages; the only QLoRA exporter reads chat pairs only — **the exact "just chat" anti-pattern the vision names.** (`observation_emit.ts:94`, `extract_companion_db_corpus.py:80-85`)

### 🔴 Missing entirely

- **Workspace + artifacts.** No workspace/project/artifact entity (only chat tables + an empty per-repo prompt-string table). Sully has **no write/mkdir tool** — `companion_tools.ts` is read-only. This is the literal reason "Today's Ops Dashboard" was narrated but never created. Canvas artifacts are ephemeral view-only state. (`companion_tools.ts:80-116`, `find ~/dev` → no dashboard dir)
- **Verification stage.** No live point checks worker output before Sully presents it.

---

## The routing-test sub-thread (the original ask)

**Good news:** the gate logic is _pure code with zero imports_ (`decisionGate.ts`, `phase_classifier.ts`) and a vitest file already exists — a scorecard is cheap to build.

**The 3-layer gate:** `ruleGate` (`@cc`/`@agy`) → `valueGate` (regex: file-path, or imperative+repo/code) → `SULLY_GATE` (cloud-model self-assessment, CLI path only). Combined in `autonomous_dispatch.ts`.

**Two real problems:**

1. **No "ask before dispatch."** The vision's 4th condition ("Captain approves investigation") is unbuilt — qualifying turns auto-fire silently with a past-tense "On it…" message. `classifyTier` already detects "planning/brainstorm" but the gate **ignores it**.
2. **Proven misfires.** False-positive: `"wire up the companion"`, `"update the kernel news"` → dispatch. False-negative: `"please go implement the login screen"`, `"fix the thing that crashes when I tap the orb"` → talk. The journal has **only 1 real dispatch** (and it was the brainstorm false-positive you fixed today) — far too little to measure empirically. **A scorecard needs a hand-built labeled fixture set.**

**The scorecard, concretely:**

- Extract a pure `decide({userText, fromTool, recentTier, gateBlock?}) → {action:'dispatch'|'talk'|'ask', worker, reason}` so the _combined_ decision is one testable function.
- `tests/fixtures/routing-cases.jsonl`: `{text, fromTool, recentTier, expected, note}` rows, seeded from the 28 real journal turns (sqlite export) + the adversarial cases above.
- `tests/routing-scorecard.test.ts`: runs every fixture through `ruleGate + valueGate + classifyTier + decide()`, prints **precision/recall + a confusion matrix** over the three intent classes.
- Capture real `SULLY_GATE` teacher blocks into fixtures so the model-vote layer can be scored **offline without a live model**.
- **Double duty:** each fixture's `expected` label IS the ground-truth route-correctness signal the journal lacks today. Write those labels into the same `quality_signal`/`verification_state` columns → the scorecard corpus becomes the **QLoRA seed set** that teaches routing/intent (not voice-from-chat).

---

## Sequenced roadmap (each phase unblocks the next)

**Phase 0 — Close the existing loops** (mostly bug-fixes, highest leverage):

- Fix empty `thread_id` routing so completions reach the live thread.
- Fix the terminal-state race (a `completed` callback arriving after abort/fail silently skips synthesis).
- Advance self-handled turns `proposed → synthesized` when Sully's reply lands.
- Add `markClassified()` → write tier onto the Task row.
- Emit the defined-but-unused `synthesis_started` / `failed` / `provider_fell_through` events.
- Add a stale-job reaper (2 jobs stuck ~2 days).
- **Runtime QA:** one real `@cc` dispatch, browser-verified end-to-end.

**Phase 1 — Routing scorecard + journal completeness** (your active ask):

- Extract the pure `decide()`; build the fixture set + scorecard with precision/recall.
- Feed `classifyTier` into the gate (suppress autonomous fire on planning/deep); tighten the regex.
- Log the route `reason` + classifier `reason/confidence` that are computed today and thrown away.

**Phase 2 — "Ask before dispatch" + real verification:**

- Add a 3rd dispatch outcome `propose` (future-tense ask on borderline gate).
- Cheap deterministic verify at `done` (does the claimed PR/file actually exist?) → stamp `verification_state`.
- Optional full auto-verify before synthesis; call `markVerified`.

**Phase 3 — Real Sully synthesis:**

- Replace the passthrough template with an LLM-router call → Captain-voiced plain-English summary.
- "Task #N is ready for review — <summary>" framing.

**Phase 4 — Memory & QLoRA learning loop:**

- Make "memory update" a terminal lifecycle stage (write a per-task outcome + local lesson).
- Capture a structured ground-truth route/quality label.
- Journal-aware QLoRA exporter via `replayTurn` (turn → tier → decision → worker → outcome → summary).

**Phase 5 — Workspace model & artifacts** (largest greenfield, most isolated):

- `workspaces` table + `workspace_id` FK; sandboxed `write_file`/`create_dir` tool; project-folder scaffolder; persist Canvas artifacts; workspace auto-suggest.

---

## First-test-project ("Today's Ops Dashboard") readiness: **NOT ready**

Blocked by two hard structural gaps: (1) no workspace container + **no write tool** (Sully physically cannot write a folder — the reason the dashboard was narrated but never created); (2) the Task lifecycle doesn't reliably terminate or surface back. **Minimum bar:** Phase 0 + the write-tool/scaffold slice of Phase 5. Verification + synthesis make it actually good.
