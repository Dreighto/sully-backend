# Sully v1 — Plan D: classify-before-answer reorder

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Builds on merged Plan C (R1 `prepareTurnLifecycle`, R2 Mutation Gate). Scope locked in `data/peer_reviews/2026-06-04_planD-scope-classify-before-answer.md`; live evidence in `data/sully_behavior_audit_2026-06-04/`.

**Goal:** Sully decides whether a turn is work **before** she answers. Work turns get the short status/proposal as the reply (no full conversational answer first); chat turns stream normally. Proves acceptance #1–#4.

**Architecture:** Today every path answers first and classifies last (`maybeAutonomousDispatch` → `decide()` runs _after_ the stream — `sdk-stream/+server.ts:314,505`; `voice-reply/+server.ts:145`). The audit confirmed the two top weaknesses are exactly this: a work turn streamed "I can create that for you" while only proposing, and the proposal took ~37s. **D1** extracts the decision into a pure `resolveTurnDecision()` + an `applyTurnDecision()` side-effect half (behavior-neutral refactor of `maybeAutonomousDispatch`), and shadow-computes the decision pre-stream for measurement. **D2** wires that pre-stream decision to gate the reply: `ANSWER_NOW` streams the full reply; everything else short-circuits to the status/proposal — and drops the CLI teacher `gateBlock` (deterministic `decide()` everywhere). Split mirrors Plan C R1→R2.

**Tech Stack:** SvelteKit server, better-sqlite3, vitest.

**Key de-risking fact:** `decide()` is deterministic and its inputs (`userText`, `tier`) are resolved by `prepareTurnLifecycle` before any token — so classifying first costs ≈0ms. The only input not available pre-stream is the CLI teacher's `gateBlock`; dropping it = the deterministic path the 95.6% scorecard already grades (and the live default path already runs).

---

# REFACTOR 1 (D1) — behavior-neutral substrate

## Task D1.0: `TurnDecision` + pure `resolveTurnDecision()`

**Files:** Create `src/lib/server/routing/turn_decision.ts`, `tests/turn-decision.test.ts`

- [ ] **Step 1: Failing tests** — mirror the existing `maybeAutonomousDispatch` branch cases as a PURE decision (DB-backed for proposal/gate reads; mock nothing that has side effects). Cases:
  - pending `routing_ask` + "run it separately" → `{kind:'ROUTING_ANSWER', answer:'sibling'}`; + "hold it" → `answer:'defer'`; + non-answer → falls through.
  - `mutationGate.classification==='RUNNING_WORK_INTENT'` → `{kind:'RUNNING_WORK_INTENT'}`; `'CONVERSATIONAL_ONLY'` → `{kind:'CONVERSATIONAL_ONLY'}`.
  - pending dispatch proposal + "yes" → `{kind:'CONFIRM_PROPOSAL'}`.
  - `@cc fix the build` → `{kind:'DISPATCH'}`; a plain work-intent ("audit the console repo") → `{kind:'PROPOSE'}`; a brainstorm ("just kicking an idea around…") → `{kind:'ANSWER_NOW'}`.
  - Assert `resolveTurnDecision` performs NO writes (snapshot `pending_jobs` row count before/after = equal).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `turn_decision.ts`** — pure reads only (`getPendingProposal`, `isRoutingAnswer`, `isAffirmation`, `decide`, `validateGate`); NO side effects. Mirror `maybeAutonomousDispatch`'s exact branch order (routing-answer → mutation gate → affirmation → `decide()`):

```ts
import { getPendingProposal, type PendingProposal } from '$lib/server/dispatchJobs';
import { isAffirmation, isRoutingAnswer } from '$lib/server/routing/confirm';
import { decide } from '$lib/server/routing/decide';
import { validateGate } from '$lib/server/decisionGate';
import type { MutationGateResult } from '$lib/server/routing/mutation_gate';
import type { Tier } from '$lib/server/phase_classifier';

export type TurnDecision =
	| { kind: 'ROUTING_ANSWER'; answer: 'sibling' | 'defer'; proposal: PendingProposal }
	| { kind: 'RUNNING_WORK_INTENT'; activeTaskId: string | null }
	| { kind: 'CONVERSATIONAL_ONLY' }
	| { kind: 'CONFIRM_PROPOSAL'; proposal: PendingProposal }
	| { kind: 'DISPATCH'; worker: 'claude-code' | 'gemini'; category: string; brief: string }
	| { kind: 'PROPOSE'; worker: 'claude-code' | 'gemini'; category: string; brief: string }
	| { kind: 'ANSWER_NOW' };

export interface ResolveTurnDecisionArgs {
	userText: string;
	threadId: string;
	mutationGate?: MutationGateResult;
	tier?: Tier;
	/** CLI teacher self-assessment. Omitted pre-stream (deterministic). */
	gateBlock?: string | null;
}

/** Pure: classify the turn's outcome from pre-/post-stream state. No writes. */
export function resolveTurnDecision(args: ResolveTurnDecisionArgs): TurnDecision {
	const { userText, threadId } = args;
	const p = getPendingProposal(threadId);

	// A. routing-ask answer
	if (p?.proposalType === 'routing_ask') {
		const answer = isRoutingAnswer(userText);
		if (answer) return { kind: 'ROUTING_ANSWER', answer, proposal: p };
		// non-answer → fall through (apply-side expires it)
	}
	// B. mutation gate
	const gc = args.mutationGate?.classification;
	if (gc === 'RUNNING_WORK_INTENT')
		return { kind: 'RUNNING_WORK_INTENT', activeTaskId: args.mutationGate?.activeTaskId ?? null };
	if (gc === 'CONVERSATIONAL_ONLY') return { kind: 'CONVERSATIONAL_ONLY' };
	// C. pending dispatch proposal + affirmation
	if (p && p.proposalType !== 'routing_ask' && isAffirmation(userText))
		return { kind: 'CONFIRM_PROPOSAL', proposal: p };
	// D. intent gate
	const d = decide({ userText, fromTool: false, recentTier: args.tier, gateBlock: args.gateBlock });
	const gate = args.gateBlock !== undefined ? validateGate(args.gateBlock ?? null) : null;
	const category = gate && gate.ok ? gate.gate.category : 'code';
	const brief = gate && gate.ok ? gate.gate.brief : userText.slice(0, 200);
	const worker: 'claude-code' | 'gemini' =
		d.worker ?? (gate && gate.ok ? gate.gate.worker : 'claude-code');
	if (d.action === 'Dispatch') return { kind: 'DISPATCH', worker, category, brief };
	if (d.action === 'Ask') return { kind: 'PROPOSE', worker, category, brief };
	return { kind: 'ANSWER_NOW' };
}
```

(Confirm `PendingProposal` is exported from `dispatchJobs.ts` with `proposalType`; if not, export it.)

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `feat(planD): pure resolveTurnDecision — classify a turn with no side effects`

---

## Task D1.1: `applyTurnDecision()` + refactor `maybeAutonomousDispatch` (behavior-neutral)

**Files:** Modify `src/lib/server/chat/autonomous_dispatch.ts`; Tests: existing `ask-before-dispatch.test.ts`, `mutation-acceptance.test.ts`, `mutation-gate-e2e.test.ts` must stay green.

- [ ] **Step 1:** Extract the side-effect body of `maybeAutonomousDispatch` into `applyTurnDecision(decision: TurnDecision, ctx: {taskId; threadId; targetRepo; userText})` — one `switch (decision.kind)` arm per kind, each performing EXACTLY the current side effects + returning `{spokenSuffix?}`:
  - `ROUTING_ANSWER` (sibling/defer) → today's Step A bodies.
  - `RUNNING_WORK_INTENT` → today's routing-ask post (status `'sent'`).
  - `CONVERSATIONAL_ONLY` → journal Talk + `markSelfHandled`.
  - `CONFIRM_PROPOSAL` → today's affirmation-dispatch body.
  - `DISPATCH` → today's Dispatch body.
  - `PROPOSE` → today's Ask body (status `'pending_approval'`).
  - `ANSWER_NOW` → journal Talk + `markSelfHandled`.
- [ ] **Step 2:** Rewrite `maybeAutonomousDispatch` to: keep the `companionDispatchEnabled` guard; expire a stale non-affirmed dispatch proposal exactly as today (the `markAborted(pending.taskId)` defensive line — keep it); `const decision = resolveTurnDecision({userText, threadId, mutationGate: args.mutationGate, tier: args.tier, gateBlock: args.gateBlock}); return applyTurnDecision(decision, {...})`. Net behavior IDENTICAL.
- [ ] **Step 3:** `npx vitest run` + `npm run check` — ALL green (this is the behavior-neutral proof). If any prior test changes outcome, the extraction diverged — fix until identical.
- [ ] **Step 4: Commit.** `refactor(planD): split maybeAutonomousDispatch into resolve + applyTurnDecision (behavior-neutral)`

---

## Task D1.2: pre-stream shadow decision (behavior-neutral)

**Files:** Modify `src/lib/server/chat/stream_prepare.ts` (`prepareTurnLifecycle` + `TurnLifecycleResult` + `PreparedStreamContext`); Tests `tests/turn-decision-shadow.test.ts`

- [ ] **Step 1:** In `prepareTurnLifecycle`, after `runMutationGate`, compute `const shadowDecision = resolveTurnDecision({ userText: text, threadId, mutationGate, tier: currentTier })` (NO `gateBlock` → deterministic) and journal it: `logTaskEvent(taskId, 'turn_decision_shadow', { kind: shadowDecision.kind })`. Add `shadowDecision: TurnDecision` to `TurnLifecycleResult` AND `PreparedStreamContext` (required field). This is a read + a journal write — does NOT touch the reply or dispatch, so behavior is unchanged.
- [ ] **Step 2: Test** — `prepareTurnLifecycle` for a brainstorm turn → `shadowDecision.kind==='ANSWER_NOW'` + a `turn_decision_shadow` journal row exists; a work-intent turn → `'PROPOSE'`; an `@cc` turn → `'DISPATCH'`. And the live reply/dispatch path is unaffected (existing sdk-stream/voice behavior tests green).
- [ ] **Step 3:** `npx vitest run` + `npm run check` green.
- [ ] **Step 4: Commit.** `feat(planD): shadow-compute the turn decision pre-stream (journaled, behavior-neutral)`

---

## D1 final review

- [ ] Full suite + `npm run check` green; D1 is behavior-neutral (no UX change — still answers-then-classifies; the pre-stream decision is shadow-only).
- [ ] Adversarial review: `resolveTurnDecision` exactly reproduces the old branching (esp. proposal expiry timing, routing-ask vs dispatch-proposal, the gateBlock-present path); `applyTurnDecision` side effects byte-identical; shadow journal doesn't alter behavior.
- [ ] PR for operator QA + merge.

---

# REFACTOR 2 (D2) — the reorder (behavior change) — OUTLINE, build after D1 merges

- **D2.0** — extract `shouldAnswerNow(decision): boolean` (`kind==='ANSWER_NOW'`) + a `shortStatusFor(decision)` helper returning the operator-facing line for each non-answer kind (reuse today's strings: "That looks like a job for CC — …", "On it — this needs digging…", the routing-ask, the confirm "On it — handing that to …"). Tests.
- **D2.1** — `sdk-stream/+server.ts`: promote `ctx.shadowDecision` to the real decision (computed pre-stream, no gateBlock). BEFORE streaming: if `shouldAnswerNow` → stream the full reply as today, then `applyTurnDecision(ANSWER_NOW)` (markSelfHandled), NO post-stream dispatch. Else → call `applyTurnDecision(decision)` and return a minimal UIMessage stream whose assistant text IS `shortStatusFor(decision)` (no model call). Remove the CLI gate-block suppression dance + `GATE_INSTRUCTION` + the post-stream `maybeAutonomousDispatch` calls.
- **D2.2** — `voice-reply/+server.ts`: same branch BEFORE `runVoiceToolLoop`; non-answer → speak only `shortStatusFor(decision)` + `applyTurnDecision`; answer → full spoken reply as today.
- **D2.3** — retire the now-unused gateBlock plumbing for the live decision (keep `ROUTING_CAPTURE_GATES` offline capture only if operator wants the data; otherwise remove). Keep `decide()` deterministic everywhere.
- **D2.4 — acceptance** (`tests/classify-before-answer-acceptance.test.ts`): #1 brainstorm → `ANSWER_NOW`, full reply, no task/dispatch; #2 work intent → task created (PROPOSE/DISPATCH) pre-reply; #3 voice + text resolve the SAME decision from the shared chokepoint; #4 a work turn does NOT invoke full model generation (assert the handler takes the short-status branch — e.g. via `shouldAnswerNow(decision)===false`).
- **Deferred (NOT D2):** legacy `/api/chat/+server.ts` reorder; richer brainstorm replies (audit tweak #3); the tier-vs-gate labeling note (audit tweak #4).

**No-regression bar for D2:** the live audit's passing behaviors must still pass (not trigger-happy; proposes-not-dispatches; verification honesty; R2 mutation safety; voice/text parity; no chat flood) — re-runnable via the harness in `data/sully_behavior_audit_2026-06-04/`.
