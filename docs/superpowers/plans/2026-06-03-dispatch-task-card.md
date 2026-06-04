# Dispatch Task Card — Seamless Hand-off UI Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]`.

**Goal:** Replace the stuck/leaking 3-block dispatch UI with one seamless morphing Task card (working → done → failed), fix the stuck-timer and raw-event-leak bugs, and finish ask-before-dispatch with tap-to-confirm buttons.

**Architecture:** A single card keyed by `trace_id` morphs in place. The card renders the _resolved_ state from server-truth on first paint (no "working" flash, no live mm:ss clock); only the one in-flight job opens a live SSE. Internal pipeline events never reach the UI (server-side allow-list). Approved design: hybrid of "One Morphing Card" + "Quiet Trace Chip" frozen-record discipline (see `data/peer_reviews/2026-06-03_sully-dispatch-ui-redesign_gpt.md`, GPT-approved 2026-06-03).

**Tech Stack:** SvelteKit (Svelte 5 runes), better-sqlite3, vitest. Server `:18769`, base `/companion`.

**Scope boundary:** This milestone = visibility fix + ask-before-dispatch buttons. NOT in scope: workspace/artifact layer, voice/text unification (those are the next milestones).

---

## Problems being solved

- **P1 — stuck timer.** Jobs end at status `synthesized`, but the terminal allow-list is `['done','failed','aborted']` (`dispatch/stream/+server.ts:55`, `dispatchStream.svelte.ts:72`), so the card never resolves. Also `WorkingBubble` runs a live `setInterval` from the message timestamp on every render → "39:53" on reload/scrollback.
- **P2 — raw leak.** `chat_activity` mixes worker steps (`reading/edited/ran/thinking`) with internal events (`synthesis_completed`, `gate_evaluated`, …). The card shows the last row verbatim → JSON leak. Plus `(Trace: sully-…)` in the notice (`api/chat/+server.ts:225`).
- **P3 — not seamless.** Notice + stuck card + answer = 3 disconnected blocks. Want one morphing card.
- **Finish ask-before-dispatch.** Server logic exists; needs tap-to-confirm buttons so "yes" isn't a typed step.

---

## Phase A — Bug fixes (ship first, independently valuable)

### Task A1: Shared displayable-step mapper + terminal-status helper

**Files:**

- Create: `src/lib/server/dispatchActivityView.ts`
- Test: `tests/dispatch-activity-view.test.ts`

- [ ] **Step 1: Write failing test** — `friendlyStep` maps worker actions to plain phrases and returns `null` for internal events; `isTerminalStatus` includes synthesized/verified.

```ts
// tests/dispatch-activity-view.test.ts
import { describe, it, expect } from 'vitest';
import {
	friendlyStep,
	isTerminalStatus,
	DISPLAYABLE_WORKER_ACTIONS
} from '$lib/server/dispatchActivityView';

describe('friendlyStep', () => {
	it('maps real worker steps to plain English', () => {
		expect(friendlyStep('ran', 'tests')).toMatch(/running/i);
		expect(friendlyStep('reading', 'src/app.ts')).toMatch(/reading/i);
		expect(friendlyStep('edited', null)).toMatch(/updating|editing|changing/i);
		expect(friendlyStep('thinking', null)).toMatch(/working|thinking/i);
	});
	it('drops internal pipeline events (no leak)', () => {
		for (const a of [
			'synthesis_completed',
			'gate_evaluated',
			'task_proposed',
			'classifier_ran',
			'reply_persisted',
			'tool_invoked',
			'provider_attempted'
		])
			expect(friendlyStep(a, '{"x":1}')).toBeNull();
	});
	it('never returns raw JSON', () => {
		expect(friendlyStep('ran', '{"outcome":"done"}') ?? '').not.toContain('{');
	});
});
describe('isTerminalStatus', () => {
	it('treats synthesized + verified as terminal', () => {
		for (const s of ['done', 'failed', 'aborted', 'synthesized', 'verified'])
			expect(isTerminalStatus(s)).toBe(true);
		for (const s of ['working', 'dispatched', 'decided', 'gated'])
			expect(isTerminalStatus(s)).toBe(false);
	});
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run tests/dispatch-activity-view.test.ts`
- [ ] **Step 3: Implement.**

```ts
// src/lib/server/dispatchActivityView.ts
// The ONLY worker actions a non-coder should see in the Task card. Everything
// else in chat_activity (gate_evaluated, synthesis_completed, …) is internal
// bookkeeping and must never surface (P2 leak fix).
export const DISPLAYABLE_WORKER_ACTIONS = ['reading', 'edited', 'ran', 'thinking'] as const;

const SUCCESS_TERMINAL = ['done', 'verified', 'synthesized'] as const;
const FAIL_TERMINAL = ['failed', 'aborted'] as const;

export function isTerminalStatus(s: string): boolean {
	return (
		(SUCCESS_TERMINAL as readonly string[]).includes(s) ||
		(FAIL_TERMINAL as readonly string[]).includes(s)
	);
}
export function isSuccessStatus(s: string): boolean {
	return (SUCCESS_TERMINAL as readonly string[]).includes(s);
}

/** Map a raw worker activity row to a plain-English status line, or null to hide it. */
export function friendlyStep(action: string, _target: string | null): string | null {
	switch (action) {
		case 'reading':
			return 'Reading the files…';
		case 'edited':
			return 'Making changes…';
		case 'ran':
			return 'Running the tests…';
		case 'thinking':
			return 'Working it through…';
		default:
			return null; // internal event — never shown
	}
}
```

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `feat(dispatch): displayable-step mapper + terminal-status helper`

### Task A2: Stop the leak + recognize terminal in the SSE stream

**Files:**

- Modify: `src/routes/api/chat/dispatch/stream/+server.ts`
- Modify: `src/routes/api/chat/dispatch/[trace]/+server.ts`
- Test: `tests/dispatch-stream-filter.test.ts` (unit-test the row filter helper if extracted; else assert via the view module)

- [ ] **Step 1:** In the SSE `pump()` query, filter to `DISPLAYABLE_WORKER_ACTIONS` so internal events never stream. Add `ended_at`/`started_at` to the `__terminal__` frame. Use `isTerminalStatus(job.status)` instead of the hard-coded triple.
- [ ] **Step 2:** In `[trace]/+server.ts`, filter `activity` through `DISPLAYABLE_WORKER_ACTIONS` too (reconcile path).
- [ ] **Step 3:** Tests green + typecheck. Commit `fix(dispatch): only stream real worker steps; synthesized/verified are terminal`.

### Task A3: Client resolves + no live clock + no SSE for finished jobs

**Files:**

- Modify: `src/lib/chat/dispatchStream.svelte.ts`
- Modify: `src/lib/components/WorkingBubble.svelte`
- Test: extend `tests/` (reconcile sets terminal from synthesized; duration label frozen)

- [ ] **Step 1:** `dispatchStream.svelte.ts`: use `isTerminalStatus`. In `start()`, `await reconcile()` FIRST; if terminal, set status and DO NOT open an SSE (kills stuck-timer + N-EventSource leak on history). Capture `started_at`/`ended_at` → expose `durationLabel`.
- [ ] **Step 2:** `WorkingBubble.svelte`: working state shows a pulse + the friendly step (no mm:ss); terminal-success renders the compact "✓ CC handled this · {durationLabel}" strip; failed renders rose strip + Retry. Map synthesized/verified/done → success (currently they fall through to "Failed").
- [ ] **Step 3:** Typecheck + tests. Commit `fix(dispatch): resolve card from server truth, drop live timer (P1)`.

---

## Phase B — One morphing card (P3 seamless)

### Task B1: Reshape the dispatch notice + render path into one card

**Files:**

- Modify: `src/routes/api/chat/+server.ts:225` (drop `(Trace: …)`; minimal/neutral text since the card carries state)
- Modify: `src/lib/components/MessageFeed.svelte` (the `sully-` system row → render the morphing card flush above the following Sully answer; remove the separate LOGUEOS text bubble for dispatch rows)
- Test: component-level reasoning via existing suites + manual browser QA

- [ ] **Step 1:** Remove trace id from the operator-facing notice text. Keep `traceId` as the message `trace_id`.
- [ ] **Step 2:** In MessageFeed, for `m.sender==='system' && trace_id startsWith 'sully-'`, render the morphing card as the single element (working/done/failed) — not a text notice + a separate card.
- [ ] **Step 3:** Browser QA on `:18769/companion` — working → done collapses to strip; reload shows resolved, never "39:53"; no JSON anywhere. Commit `feat(dispatch): single morphing Task card (P3)`.

---

## Phase C — Finish ask-before-dispatch (tap-to-confirm)

### Task C1: Confirm endpoint

**Files:**

- Create: `src/routes/api/chat/dispatch/confirm/+server.ts`
- Test: `tests/dispatch-confirm.test.ts`

- [ ] **Step 1:** Failing test: POST `{taskId, decision:'run'}` on a gated proposal → dispatches (job leaves 'gated'); `{decision:'dismiss'}` → markAborted. Unknown/expired taskId → 404/410.
- [ ] **Step 2:** Implement: look up `getPendingProposal`-style by taskId; on run → `dispatchToWorker(...)` + post the dispatch system message (reuse the autonomous_dispatch confirm shape); on dismiss → `markAborted` + post a brief "Okay, skipped that." Tailnet/Funnel guard like the other dispatch routes.
- [ ] **Step 3:** Tests green. Commit `feat(dispatch): confirm endpoint for ask-before-dispatch`.

### Task C2: Buttons on the Ask bubble

**Files:**

- Modify: `src/lib/server/chat/autonomous_dispatch.ts` (tag the Ask message metadata `kind:'proposal'`)
- Modify: `src/lib/components/MessageFeed.svelte` (render Run / Not now under a proposal message; call the confirm endpoint; optimistic disable after tap)
- Test: existing ask-before-dispatch suite + browser QA

- [ ] **Step 1:** Add `kind:'proposal'` to the Ask message metadata.
- [ ] **Step 2:** MessageFeed: for a proposal message, show two buttons (fuchsia "Run it" / ghost "Not now"), 44px targets; on tap call confirm endpoint, then refresh feed. Hide buttons once acted (and on expiry).
- [ ] **Step 3:** Browser QA: ambiguous work intent → Ask bubble with buttons → tap Run → morphing card appears → result. Commit `feat(dispatch): tap-to-confirm buttons for ask-before-dispatch`.

---

## Phase D — Verify + handoff

- [ ] Full suite green (`npx vitest run`) + `npm run check` (0 type errors).
- [ ] Adversarial review subagent over the diff (non-coder clarity + the reload/scrollback/missing-answer edge cases the critic flagged).
- [ ] Update `docs/SESSION-HANDOFF.md`. Operator does live QA on his phone, then merges (his standing pattern: "Live QA first, then I merge").

---

## Deferred (noted, NOT built here)

Soft-stall threshold (~90s "taking longer than usual" before the 15-min reaper), Retry-safety guard for partial coding work, push→first-paint highlight, "Sully is writing it up…" interstitial, the tap-for-steps audit sheet + on-demand trace id. These are GPT's open questions — revisit after this milestone lands.
