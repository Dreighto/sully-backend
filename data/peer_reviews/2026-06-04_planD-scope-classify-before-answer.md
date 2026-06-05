# Plan D — classify-before-answer reorder · scope proposal

**Date:** 2026-06-04 · **For:** operator review BEFORE implementation · **Status:** scoped, grounded in current code. Proves acceptance #1–#4 (the last four of the v1 eight).

---

## The problem (grounded)

Today, **all three turn paths answer first and classify last.** Sully produces a full reply, _then_ decides whether the turn was even a chat turn:

- **Text — CLI-bridge path** (Sonnet/Opus): streams the full reply, then calls `maybeAutonomousDispatch` → `decide()`. (`sdk-stream/+server.ts:314`)
- **Text — direct path** (Haiku/Gemini/local — Sully's **default**): streams the full reply in `streamText`, then `onFinish` calls `maybeAutonomousDispatch` → `decide()`. (`sdk-stream/+server.ts:505`)
- **Voice**: generates the FULL spoken reply (`runVoiceToolLoop` → `full`), speaks it sentence-by-sentence, persists it, THEN calls `maybeAutonomousDispatch` and appends the proposal/dispatch notice as a trailing spoken sentence. (`voice-reply/+server.ts:113→145`)

So for a work turn like "audit the console repo," Sully streams/speaks a full conversational answer she shouldn't have produced — possibly contradicting or pre-empting the actual work — and only _afterward_ offers to dispatch. In voice this is worst: she rambles a full spoken answer, then says "Want me to run it?" (There's even a literal `"Let me look that up."` filler at `voice-reply:107`.) **This is acceptance #4: worker-dependent turns must NOT stream a full answer before classification.**

## The key finding that de-risks this

The audits (Plan C brief) flagged **latency** as the main risk of classifying before answering — assuming an LLM classifier before the first token. **That fear is moot:** `decide()` (the Intent Gate) is **already deterministic** (`ruleGate` = `@cc`/`@agy`; `valueGate` = file/code/repo/long-imperative signals — no LLM), and **all its inputs are already resolved pre-stream** by `prepareTurnLifecycle` (`userText`, `tier`). The Mutation Gate (R2) is also deterministic and already runs pre-stream. So **moving the decision before the reply costs ≈ 0 ms.**

The one input `decide()` uses that isn't available pre-stream is the **CLI teacher's `gateBlock`** (Opus's hidden `<<<SULLY_GATE…>>>` self-assessment appended to its reply). Classifying pre-stream means dropping that — i.e. **deterministic `decide()` for all paths.** That is _already_ the live behavior on the direct/local path (Sully's default model) and exactly what the **95.6% scorecard gate** grades. Bonus: dropping it **simplifies** the CLI path (removes the gate-block suppression dance + `GATE_INSTRUCTION`).

## Plan D behavior (strict + linear, like the rest of v1)

Compute the full turn **decision pre-stream**, compose the two gates already designed:

1. **Mutation Gate (R2)** runs first (already pre-stream): `RUNNING_WORK_INTENT` / `CONVERSATIONAL_ONLY` / routing-answer → handled as today (ask / defer / sibling / talk).
2. Else the **Intent Gate** (`decide()`, deterministic, no `gateBlock`) → `ANSWER_NOW` (Talk) / `PROPOSE` (Ask) / `DISPATCH`. Plus the pending-proposal **affirmation** ("yes") consumption — also moved pre-stream.

Then **branch the reply on the decision:**

- **`ANSWER_NOW`** → generate + stream the full reply (today's path). No dispatch.
- **everything else** (PROPOSE / DISPATCH / routing-ask / affirmation-confirm) → the assistant's reply **IS the short status/proposal** ("That looks like a job for CC — want me to run it?" / "On it — this needs digging…"). **No full conversational generation.** The side-effects (mint/promote task, dispatch, store proposal) fire pre-stream.

Applied in the **shared chokepoint** so text + voice can't drift. In voice this means: a work turn **speaks only the short proposal/status**, never a full spoken answer first.

### Proves the acceptance tests

- **#1 Brainstorming does not auto-dispatch** — brainstorm → `ANSWER_NOW` → full reply, no dispatch (now enforced pre-stream, not hoped-for post-stream).
- **#2 Explicit work intent creates a task** — `DISPATCH`/`PROPOSE` mints/promotes the task pre-stream.
- **#3 Voice + text same pipeline** — one `TurnDecision` computed in `prepareTurnLifecycle`; both handlers branch on it.
- **#4 No full answer before classification** — full generation is gated behind `ANSWER_NOW`.

## What changes (files)

- `chat/stream_prepare.ts` (`prepareTurnLifecycle`) — compute + attach a single `TurnDecision` (compose Mutation Gate + Intent Gate + pending-proposal affirmation), pre-stream.
- `chat/autonomous_dispatch.ts` — split into `resolveTurnDecision()` (decide, pre-stream) + `applyTurnDecision()` (the side-effects). The post-stream call goes away.
- `sdk-stream/+server.ts` — branch BOTH the CLI-bridge and direct paths on `TurnDecision`; only `ANSWER_NOW` generates a full reply; drop the teacher gate-block dance.
- `voice-reply/+server.ts` — branch before `runVoiceToolLoop`; work turns speak only the short status.
- **Deferred (as in Plan C):** legacy `/api/chat/+server.ts` reorder; the teacher-gateBlock offline capture can stay decoupled (or be retired).

## Risks + sequencing

- **The streaming restructure is the delicate part** — three different stream shapes (CLI `createUIMessageStream`, direct `streamText`, voice `ReadableStream`). Mitigation: the incremental split below + heavy tests + the existing scorecard gate.
- **Dropping the teacher gateBlock** changes borderline CLI-path decisions vs today (the default path is unaffected — it never had one). Mitigation: D1 shadow-compares the deterministic decision against the teacher's on real CLI turns before we flip.
- **False-positive work classification** short-circuits a chat turn (proposes when she should've chatted). Recoverable ("Not now"); the gate is precision-tuned + scorecard-graded.
- **Work-turn assistant bubble** — recommend the short status/proposal text _streams as the assistant reply_ (a fixed string, no model call) so the bubble isn't empty and voice speaks it.

### Recommended split (mirrors Plan C's proven substrate-first approach)

- **D1 — substrate (behavior-neutral):** extract `resolveTurnDecision()` and compute the decision **pre-stream**, attach to the context + **journal it as a shadow** — but DON'T change streaming yet (still stream full + still dispatch post-stream). Verify the pre-stream deterministic decision matches the live one across real turns (esp. the CLI path without the teacher). Zero UX change.
- **D2 — the reorder (behavior change):** branch the handlers on the pre-stream decision; non-`ANSWER_NOW` short-circuits (no full reply); remove the post-stream dispatch + the CLI gate-block dance. Proves #1–#4.

Because the deterministic decision is _already_ live on Sully's default path, D1 can be lightweight (a shadow-journal pass focused on the CLI path), or folded into D2 if you'd rather move in one pass.

## Decisions for you

1. **Split or one pass?** Recommend the **D1/D2 split** (safety, consistent with Plan C). One pass is viable since the default path already classifies deterministically.
2. **Drop the teacher `gateBlock`** for the live decision (deterministic `decide()` everywhere)? Recommend **yes** — it's what the scorecard grades + simplifies the CLI path. (Offline capture for scoring can stay if you want the data.)
3. **Work-turn reply surface** — confirm the short status/proposal **streams as the assistant message** (so voice speaks it, bubble isn't empty). Recommend **yes.**

Awaiting your call on these before I write the implementation plan.
