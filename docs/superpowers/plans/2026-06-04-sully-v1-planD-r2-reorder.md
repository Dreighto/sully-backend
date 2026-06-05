# Sully v1 — Plan D / Refactor 2 (D2): the classify-before-answer reorder

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Builds on merged D1 (`resolveTurnDecision`/`applyTurnDecision` + the pre-stream `shadowDecision` on `PreparedStreamContext`/`TurnLifecycleResult`). Grounded in the frontend flow mapped 2026-06-04 + the live audit (`data/sully_behavior_audit_2026-06-04/`).

**Goal:** A work turn no longer streams a full conversational answer before classifying. The pre-stream decision (`shadowDecision`, deterministic) gates the reply: a turn that "needs a full reply" streams normally; everything else short-circuits to the proposal/status (no model call). Proves acceptance #1–#4. Fixes the audit's two findings (the "I can create that for you" mixed message + the ~37s pre-proposal latency).

**Architecture:** Promote D1's pre-stream `ctx.shadowDecision` to THE decision. In each handler, branch BEFORE generating: `needsFullReply(decision)` → generate + stream the reply, then `applyTurnDecision` (Talk/markSelfHandled); else → `applyTurnDecision` FIRST (writes the proposal/dispatch/routing-ask + returns `{spokenSuffix}`), then return an EMPTY UIMessage stream (text) or speak only the `spokenSuffix` (voice). The proposal surfaces via the existing 3s poll. Drop the CLI teacher `gateBlock` (the decision is now deterministic). Keep `maybeAutonomousDispatch` intact for the legacy `/api/chat` handler + tests.

**Tech Stack:** SvelteKit server + Svelte 5 frontend, better-sqlite3, vitest.

**`needsFullReply(decision)` = `kind === 'ANSWER_NOW' || kind === 'CONVERSATIONAL_ONLY'`.** Both mean "answer normally" (CONVERSATIONAL_ONLY = chatting while a task runs — must NOT be blocked, acceptance #7). All other kinds (PROPOSE / DISPATCH / CONFIRM_PROPOSAL / ROUTING_ANSWER / RUNNING_WORK_INTENT) are handled by the short status/side-effect with no full reply.

---

## Task D2.0: the `needsFullReply` predicate

**Files:** Modify `src/lib/server/routing/turn_decision.ts`; Tests `tests/turn-decision.test.ts`

- [ ] **Step 1:** Add + export:

```ts
/** True when the turn should generate a full conversational reply (pure chat,
 *  or chat while a task runs). All other decisions short-circuit to a short
 *  status/proposal with no model generation. */
export function needsFullReply(decision: TurnDecision): boolean {
	return decision.kind === 'ANSWER_NOW' || decision.kind === 'CONVERSATIONAL_ONLY';
}
```

- [ ] **Step 2: Tests** — `ANSWER_NOW`→true, `CONVERSATIONAL_ONLY`→true, `PROPOSE`/`DISPATCH`/`CONFIRM_PROPOSAL`/`ROUTING_ANSWER`/`RUNNING_WORK_INTENT`→false.
- [ ] **Step 3:** `npx vitest run tests/turn-decision.test.ts` green.
- [ ] **Step 4: Commit.** `feat(planD): needsFullReply predicate (D2.0)`

---

## Task D2.1: reorder the SDK-stream handler

**Files:** Modify `src/routes/api/chat/sdk-stream/+server.ts`

Current: both the CLI-bridge and direct paths stream the full reply, then call `maybeAutonomousDispatch` (CLI: lines ~314 with gateBlock; direct: ~505 fire-and-forget). Replace with a pre-stream branch on `ctx.shadowDecision`.

- [ ] **Step 1:** After `const ctx = await prepareStream(...)`, destructure `shadowDecision` (already on ctx). `const decision = ctx.shadowDecision;`

- [ ] **Step 2: WORK-turn short-circuit (before the CLI/direct branches):**

```ts
if (!needsFullReply(decision)) {
	// Classify-before-answer: a work turn produces NO conversational reply.
	// applyTurnDecision writes the proposal/dispatch/routing-ask + the operator
	// sees it via the 3s poll. Return a valid-but-empty UIMessage stream so the
	// SDK client closes cleanly (the frontend deletes the empty placeholder).
	await applyTurnDecision(decision, { taskId, threadId, targetRepo, userText: userMessageText });
	const stream = createUIMessageStream({
		execute: ({ writer }) => {
			const messageId = generateId();
			writer.write({ type: 'start', messageId });
			writer.write({ type: 'finish', finishReason: 'stop' });
		}
	});
	return createUIMessageStreamResponse({ stream });
}
```

(Import `applyTurnDecision` + `needsFullReply`. Note: NO `text-start`/`text-delta`/`text-end` — an empty assistant message.)

- [ ] **Step 3: ANSWER_NOW / CONVERSATIONAL_ONLY = full reply.** Keep the existing CLI-bridge + direct streaming bodies, with these changes:
  - **CLI path:** drop the gate dance — set `cliSystemPrompt = systemPrompt` (NO `GATE_INSTRUCTION`); stop suppressing `<<<SULLY_GATE>>>` (the model won't emit it without the instruction) — stream + persist the reply plainly (remove `extractGateBlock`/the held-back-tail logic, just stream deltas + persist `collected`). After persist, replace the old `maybeAutonomousDispatch({gateBlock})` call with `await applyTurnDecision(decision, { taskId, threadId, targetRepo, userText: userMessageText })` (decision is ANSWER_NOW/CONVERSATIONAL_ONLY → journals Talk + markSelfHandled).
  - **Direct path:** in `onFinish`, replace the fire-and-forget `maybeAutonomousDispatch` with `void applyTurnDecision(decision, {...}).catch(...)` (same fire-and-forget pattern; decision is Talk-class).
  - Remove now-unused imports (`extractGateBlock`, `GATE_INSTRUCTION`, `maybeAutonomousDispatch`) IF no longer referenced in this file.

- [ ] **Step 4:** `npm run check` + `npx vitest run` green. (Route handlers aren't unit-tested directly; rely on typecheck + the acceptance tests in D2.4 + the live audit re-run.)
- [ ] **Step 5: Commit.** `feat(planD): SDK-stream classifies before answering — work turns short-circuit, no gateBlock (D2.1)`

---

## Task D2.2: reorder the voice handler

**Files:** Modify `src/routes/api/chat/voice-reply/+server.ts`

Current: always runs `runVoiceToolLoop` (full spoken reply), persists, then `maybeAutonomousDispatch` appends `spokenSuffix`.

- [ ] **Step 1:** After `prepareTurnLifecycle`, `const decision = shadowDecision;` (destructure it).
- [ ] **Step 2: WORK-turn short-circuit (before building the voice prompt / tool loop):**

```ts
if (!needsFullReply(decision)) {
	const { spokenSuffix } = await applyTurnDecision(decision, {
		taskId,
		threadId,
		targetRepo,
		userText: text
	});
	const enc = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			if (spokenSuffix) controller.enqueue(enc.encode(spokenSuffix));
			controller.close();
		}
	});
	return new Response(stream, {
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
	});
}
```

(So a work turn speaks ONLY the short status — never a full spoken answer first.)

- [ ] **Step 3: ANSWER_NOW / CONVERSATIONAL_ONLY = full spoken reply.** Keep the existing `runVoiceToolLoop` body + persist; in the `finally`, replace `maybeAutonomousDispatch(...)` with `applyTurnDecision(decision, {...})` and still `controller.enqueue(' ' + r.spokenSuffix)` if it returns one (for a Talk decision it returns `{}`, so no suffix — fine).
- [ ] **Step 4:** `npm run check` + `npx vitest run` green.
- [ ] **Step 5: Commit.** `feat(planD): voice classifies before answering — work turns speak only the short status (D2.2)`

---

## Task D2.3: frontend — drop the empty placeholder cleanly

**Files:** Modify `src/lib/chat/streaming.svelte.ts`

A work turn returns an empty stream → the placeholder bubble stays `message: ''` → `MessageFeed` would show hanging thinking-dots. Delete the empty placeholder when the stream ends with no text, before the reconcile poll.

- [ ] **Step 1:** In the streaming controller's `finally`/post-stream block (around the `if (!errored) await deps.pollMessages()` reconcile), add: if not errored, find the placeholder (`STREAM_ID`) and if its `message` is empty, remove it from `deps.getMessages()` before `pollMessages()`. (Exact shape per the mapped flow — `streaming.svelte.ts` lines ~172-186.)
- [ ] **Step 2:** Manual reasoning check (no unit test for the Svelte controller): an empty-stream work turn → placeholder removed → `pollMessages()` (fires immediately on stream end) surfaces the proposal bubble with Run it/Not now buttons, no hanging dots. A normal ANSWER_NOW turn → placeholder has text → kept.
- [ ] **Step 3:** `npm run check` green.
- [ ] **Step 4: Commit.** `fix(planD): remove empty assistant placeholder on a short-circuited work turn (D2.3)`

---

## Task D2.4: acceptance tests #1–#4

**Files:** Create `tests/classify-before-answer-acceptance.test.ts`

Test at the decision layer (the route handlers aren't unit-testable, but the decision + `needsFullReply` are the load-bearing logic; the live audit re-run is the integration proof).

- [ ] **#1 Brainstorming does not auto-dispatch:** a brainstorm userText through `resolveTurnDecision` → `ANSWER_NOW`; `needsFullReply` true; no task promoted past 'proposed', no dispatch.
- [ ] **#2 Explicit work intent creates a task:** a work userText → `PROPOSE` (or `DISPATCH` with @cc); `needsFullReply` false; `applyTurnDecision` mints/promotes the task (a `gated` row for PROPOSE, dispatch for DISPATCH).
- [ ] **#3 Voice + text resolve the SAME decision from the shared chokepoint:** `prepareTurnLifecycle({source:'chat'})` and `({source:'voice'})` on the same userText + thread state yield the same `shadowDecision.kind`.
- [ ] **#4 A work turn does not generate a full reply:** for a work userText, `needsFullReply(resolveTurnDecision(...))` is false (the handler's gate for skipping model generation). For a brainstorm, true.
- [ ] **Step: Run** `npx vitest run` full + `npm run check` green.
- [ ] **Commit.** `test(planD): acceptance #1-#4 (classify-before-answer)`

---

## Final review + deploy gate

- [ ] Full suite + `npm run check` green.
- [ ] Adversarial review (focus: ANSWER_NOW/CONVERSATIONAL_ONLY still stream a full reply on CLI + direct + voice; the empty-stream work path is a valid SDK stream; no double-dispatch — `applyTurnDecision` runs exactly once per turn; `maybeAutonomousDispatch` still intact for legacy/tests; gateBlock removal didn't strand references; the frontend placeholder cleanup doesn't drop a real reply).
- [ ] **Post-deploy: RE-RUN the live audit harness** (`data/sully_behavior_audit_2026-06-04/`) to confirm the 10/10 routing/safety holds AND the two weaknesses are fixed (work turn shows the proposal first, no full pre-answer; latency down from ~37s). This is the integration proof the unit tests can't give.
- [ ] **Deferred (NOT D2):** legacy `/api/chat` reorder; richer brainstorm replies (audit tweak #3); the tier-vs-gate labeling note (#4); retiring `maybeAutonomousDispatch` once the legacy path migrates.
