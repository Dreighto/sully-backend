# Sully v1 — Fact-Gate (narrow first cut) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** On conversational (`ANSWER_NOW`) turns, classify the answer's fact-sensitivity and, when it's a checkable fact, instruct Sully to **source it or say she can't confirm** — never state an unverified fact as certain. Casual chat / opinions / plans / creative stay free (no web, no slowdown). (Implements spec Contract 4 + I9; narrow first cut per operator directive.)

**Architecture:** A pure heuristic classifier `factGate(userText)` → `{ category: 'conversational' | 'world_fact' | 'system_fact', sensitive }`. The two system-prompt builders (`buildSystemPrompt` text, `buildVoiceSystemPrompt` voice) already receive the user message, so they call `factGate` themselves and append a **fact-discipline clause** when `sensitive` — no turn-pipeline edits. The model then uses its existing web/read tools to source the fact (or hedges / says cannot-confirm). Deterministic source-grading + Category-3 self-checks (reusing `verifyPoll.ts`) are the **expand** phase, out of this cut.

**Tech Stack:** SvelteKit server, vitest. Pure TS classifier; prompt-string assembly.

**Scope (narrow):** the GATE + the discipline clause only. NOT in this cut: actually executing the web/Go-No-Go check server-side, source-quality scoring, a fact-routing scorecard. Those expand after this lands (they reuse Plan A's `verifyPoll.ts`).

---

## File structure

- **Create** `src/lib/server/routing/factGate.ts` — the pure classifier.
- **Create** `tests/fact-gate.test.ts` — classifier unit tests.
- **Modify** `src/lib/server/chat_prompt.ts` — fact-discipline clauses + inject into `buildSystemPrompt` (text) and `buildVoiceSystemPrompt` (voice).
- **Create** `tests/fact-gate-prompt.test.ts` — the clause appears only for fact-sensitive turns (text + voice).

---

## Task FG0: the pure classifier

**Files:** Create `src/lib/server/routing/factGate.ts`, `tests/fact-gate.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/fact-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { factGate } from '$lib/server/routing/factGate';

describe('factGate — conversational (answer free)', () => {
	for (const t of [
		'what do you think about a health widget?',
		'should we ship the dashboard first?',
		'I feel like the rabbit icon is the right direction',
		'brainstorm some names for this',
		'how would you approach the layout?',
		'explain how dispatch works'
	])
		it(`conversational: "${t}"`, () => {
			expect(factGate(t).category).toBe('conversational');
			expect(factGate(t).sensitive).toBe(false);
		});
});

describe('factGate — world/current facts (source-check)', () => {
	for (const t of [
		'what time does Dune start at the downtown theater?',
		'how much is the Jetson Orin Nano Super right now?',
		'is the coffee shop on 5th open today?',
		'what is the current price of bitcoin',
		'when does the new season release',
		"what's the latest on the OpenAI news",
		'does a library called bun-sqlite exist'
	])
		it(`world_fact: "${t}"`, () => {
			expect(factGate(t).category).toBe('world_fact');
			expect(factGate(t).sensitive).toBe(true);
		});
});

describe('factGate — system/work facts (deterministic check)', () => {
	for (const t of [
		'is the companion service up right now?',
		'are there any open PRs?',
		'did the last build pass?',
		'what does the git log say happened yesterday',
		'is port 18769 listening'
	])
		it(`system_fact: "${t}"`, () => {
			expect(factGate(t).category).toBe('system_fact');
			expect(factGate(t).sensitive).toBe(true);
		});
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run tests/fact-gate.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/server/routing/factGate.ts`** — deterministic, precision-biased (default `conversational` so casual chat stays free; only fire on clear fact signals):

```ts
// Fact-Sensitivity Gate (spec Contract 4 / I9). Pure, deterministic, no LLM.
// Runs on conversational (ANSWER_NOW) turns to decide whether the answer needs
// a source/check before being stated as fact. Precision-biased: default to
// 'conversational' (answer free) — only escalate on clear fact signals, so
// casual chat is never slowed or web-searched.

export type FactCategory = 'conversational' | 'world_fact' | 'system_fact';
export interface FactGateResult {
	category: FactCategory;
	sensitive: boolean; // category !== 'conversational'
	reason: string;
}

// System/work-state questions (asking ABOUT state, not asking to CHANGE it —
// work intent is handled upstream by the Intent Gate). Checked FIRST so e.g.
// "is the build passing" goes system, not world.
const SYSTEM_RE =
	/\b(service|server|daemon|process|port|disk|cpu|memory|deploy(ed|ment)?|build|ci\b|pipeline|test(s| suite| pass)|pr\b|pull request|branch|commit|git\b|log(s)?|database|db\b|table|endpoint|uptime|health|systemctl|companion|orchestrator|console)\b/i;
const SYSTEM_ASK_RE =
	/\b(is|are|did|does|was|were|how many|what('?s| is| does)|status|running|up|down|listening|passing|failed|merged|open)\b/i;

// World/current facts — checkable against the world, can change.
const WORLD_RE =
	/\b(time|when|what time|hours?|open(ing)?|clos(e|ing|ed)|schedule|showtime|price|cost|how much|\$|location|address|where|near( ?by)?|available|availability|in stock|weather|forecast|news|latest|current(ly)?|today|tonight|right now|this week|release(d| date)?|score|rate|exchange|law|rule|regulation|version|does .* exist)\b/i;

// Strong conversational markers — opinions/plans/creative/reasoning answer free
// even if a fact keyword brushes past.
const CONVO_RE =
	/\b(think|opinion|feel|prefer|should we|what if|imagine|brainstorm|idea|ideas|design|vibe|approach|how would you|explain|why do|in your view|recommend|suggest)\b/i;

export function factGate(userText: string): FactGateResult {
	const t = (userText || '').trim();
	if (!t) return { category: 'conversational', sensitive: false, reason: 'empty' };

	// Opinion/plan/creative framing wins — never source-check a "what do you think".
	if (
		CONVO_RE.test(t) &&
		!/\b(price|how much|what time|is .* (up|open|running)|current price)\b/i.test(t)
	)
		return { category: 'conversational', sensitive: false, reason: 'conversational marker' };

	if (SYSTEM_RE.test(t) && SYSTEM_ASK_RE.test(t))
		return { category: 'system_fact', sensitive: true, reason: 'system/work state question' };

	if (WORLD_RE.test(t))
		return { category: 'world_fact', sensitive: true, reason: 'world/current fact' };

	return { category: 'conversational', sensitive: false, reason: 'no fact signal' };
}
```

- [ ] **Step 4: Run, verify pass.** `npx vitest run tests/fact-gate.test.ts` → PASS. (If a fixture mis-classifies, adjust the regex — do NOT weaken a test; the taxonomy must match the spec's trigger list.)
- [ ] **Step 5: Commit.** `git add src/lib/server/routing/factGate.ts tests/fact-gate.test.ts && git commit -m "feat(factgate): pure fact-sensitivity classifier (Contract 4)"`

---

## Task FG1: inject the fact-discipline clause into the prompts (text + voice)

**Files:** Modify `src/lib/server/chat_prompt.ts`; Create `tests/fact-gate-prompt.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/fact-gate-prompt.test.ts` (assert the clause appears for fact turns, not casual ones, on BOTH builders):

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({
	env: { LOGUEOS_APP_MODE: 'companion', LOGUEOS_MEMORY_DB_PATH: '/tmp/sully-factprompt-test.db' }
}));

describe('fact-discipline clause injection', () => {
	it('text: a world-fact question gets the source-or-confirm clause', async () => {
		const { buildSystemPrompt } = await import('$lib/server/chat_prompt');
		const p = await buildSystemPrompt(
			{ targetRepo: 'companion', currentTier: 'chat', threadId: 'default', allowSensitive: true },
			'what time does the movie start at the downtown theater?'
		);
		expect(p.toLowerCase()).toMatch(/source|according to|couldn.t confirm|can.t confirm/);
	});
	it('text: a casual opinion gets NO fact clause', async () => {
		const { buildSystemPrompt } = await import('$lib/server/chat_prompt');
		const p = await buildSystemPrompt(
			{ targetRepo: 'companion', currentTier: 'chat', threadId: 'default', allowSensitive: true },
			'what do you think about the rabbit icon direction?'
		);
		expect(p).not.toMatch(/According to X|couldn't confirm that|find a reliable source/);
	});
	it('voice: a world-fact question gets the clause too', async () => {
		const { buildVoiceSystemPrompt } = await import('$lib/server/chat_prompt');
		const p = await buildVoiceSystemPrompt('default', 'how much does the new GPU cost right now?');
		expect(p.toLowerCase()).toMatch(/source|according to|couldn.t confirm|can.t confirm/);
	});
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run tests/fact-gate-prompt.test.ts` → FAIL.

- [ ] **Step 3: Add the clauses + a helper in `chat_prompt.ts`** (near the other base constants):

```ts
import { factGate } from '$lib/server/routing/factGate';

// Fact-Sensitivity discipline (Contract 4 / I9). Appended ONLY when the turn is
// a checkable fact — casual chat gets nothing extra.
const FACT_DISCIPLINE_WORLD = `

FACT CHECK — this turn asks for a current/external fact (a time, price, status, schedule, "does X exist", etc.). Do NOT answer it from memory. Use your web tools to find a real source, and say where it came from ("According to …"). If the source looks weak or could be stale, say so. If you can't find a reliable source, say "I couldn't confirm that" and offer to dig — never present an unverified fact as certain. Anything that can change (times, prices, availability, schedules, rules, current status) is attributed, never stated as absolute.`;

const FACT_DISCIPLINE_SYSTEM = `

FACT CHECK — this turn asks about real system/work state. Do NOT answer from memory or assumption. Use your read tools to check the actual state; if you can't verify it, say "I couldn't confirm that" rather than guessing.`;

function factClause(userMessage?: string): string {
	if (!userMessage) return '';
	const g = factGate(userMessage);
	if (g.category === 'world_fact') return FACT_DISCIPLINE_WORLD;
	if (g.category === 'system_fact') return FACT_DISCIPLINE_SYSTEM;
	return '';
}
```

- [ ] **Step 4: Inject into `buildSystemPrompt`** — change the `head` assembly (line ~121) to include the clause:

```ts
const head = `${base}${working}${semantic}${tools}${factClause(userMessage)}`;
```

- [ ] **Step 5: Inject into `buildVoiceSystemPrompt`** — change its return (line ~183) to append the clause (its message param is `text`):

```ts
return `${COMPANION_VOICE_BASE}\n\nThe current date and time is ${now}.${memory}${factClause(text)}`;
```

(Confirm the voice builder's message parameter name — it's the second arg, `text`. Use whatever the signature actually names it.)

- [ ] **Step 6: Run, verify pass.** `npx vitest run tests/fact-gate-prompt.test.ts` → PASS. Then FULL suite `npx vitest run` + `npm run check` → all green, 0 type errors.
- [ ] **Step 7: Commit.** `git add src/lib/server/chat_prompt.ts tests/fact-gate-prompt.test.ts && git commit -m "feat(factgate): inject fact-discipline clause into text + voice prompts"`

---

## Final review

- [ ] Full suite + `npm run check` green.
- [ ] Adversarial review of the diff (focus: over-triggering on casual chat (precision), the conversational-marker override, voice + text parity, no not-ours files committed).
- [ ] Note for the expand phase: deterministic Category-3 self-checks (reuse `verifyPoll.ts`) + source-quality grading + a fact-routing scorecard. Operator live-QA + merge.
