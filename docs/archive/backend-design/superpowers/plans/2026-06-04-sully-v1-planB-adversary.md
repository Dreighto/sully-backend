# Sully v1 — Plan B: Stakes-Gated Adversary Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** After deterministic verification, on **high-stakes** tasks, run an AI adversary that reviews the result + the Go/No-Go matrix and **adds concerns** (risks, gaps, weak assumptions, overclaims) — surfaced in Sully's answer as _judgment, clearly labeled, never as fact_. (Proves acceptance test **#6**; spec §5 `REVIEWING`, §8 stakes gate, Contract 3 `AdversaryFinding[]`, I1.)

**Architecture:** A new `adversary.ts`: a deterministic **stakes gate** `shouldReview(job, evidence)` + an LLM **reviewer** `runAdversaryReview({brief, result, matrix})`. In `closeOutTask`, after the Go/No-Go poll, if stakes are high → run the reviewer → journal `adversary_reviewed` → pass the concerns into `synthesizeWorkerResult`, which adds a judgment-framed "Reviewer concern" note. The adversary **can only add concerns / lower confidence — never confirm, never upgrade** (I1). It is **total**: any error/timeout → no concerns, proceed (I7) — it never blocks the result.

**Tech Stack:** SvelteKit server, vitest, `runConsultClaude` (Haiku, same bridge as synthesis).

**Scope (narrow):** stakes gate + reviewer + concerns surfaced in the answer + journaled. **NOT in this cut:** a distinct `NEEDS_REVIEW` terminal UI state, multi-round/panel review, the self-repair loop (all v2). A serious concern surfaces as a loud "Reviewer concern" in the answer; escalating it to a separate task state is deferred.

---

## File structure

- **Create** `src/lib/server/routing/adversary.ts` — `shouldReview()` (deterministic) + `runAdversaryReview()` (LLM, total) + `AdversaryFinding` type.
- **Create** `tests/adversary.test.ts` — stakes gate (deterministic) + reviewer (mocked LLM, totality).
- **Modify** `src/lib/server/routing/synthesize.ts` — add a `concerns?: string[]` param → judgment-framed "Reviewer concern" note.
- **Modify** `src/lib/server/completionClose.ts` — wire the gate + reviewer between the poll and synthesis; journal `adversary_reviewed`.
- **Modify** `src/lib/server/chatActivity.ts` — add `'adversary_reviewed'` to `TASK_EVENT_ACTIONS`.
- **Create** `tests/adversary-acceptance.test.ts` — #6: concerns labeled as judgment, not fact; low-stakes → skipped.

---

## Task B0: stakes gate + adversary reviewer (`adversary.ts`)

**Files:** Create `src/lib/server/routing/adversary.ts`, `tests/adversary.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/adversary.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const consult = vi.fn();
vi.mock('$lib/server/chat/consult', () => ({
	runConsultClaude: (...a: unknown[]) => consult(...a)
}));

describe('shouldReview (deterministic stakes gate)', () => {
	it('reviews code/file/state-changing work', async () => {
		const { shouldReview } = await import('$lib/server/routing/adversary');
		expect(shouldReview({ category: 'code' } as never, {})).toBe(true);
		expect(shouldReview({ category: 'general' } as never, { fs_paths: ['x'] })).toBe(true);
		expect(shouldReview({ category: 'general' } as never, { git_ref: 'abc1234' })).toBe(true);
		expect(shouldReview({ category: 'general' } as never, { pr_number: 5 })).toBe(true);
	});
	it('skips low-stakes (no code, no state-change evidence)', async () => {
		const { shouldReview } = await import('$lib/server/routing/adversary');
		expect(shouldReview({ category: 'general' } as never, {})).toBe(false);
		expect(shouldReview({ category: 'general' } as never, { health_url: 'http://x' })).toBe(false);
	});
});

describe('runAdversaryReview (LLM, total)', () => {
	it('parses a JSON array of concerns from the model', async () => {
		consult.mockResolvedValueOnce({
			answer: '[{"concern":"removes error handling","severity":"high"}]'
		});
		const { runAdversaryReview } = await import('$lib/server/routing/adversary');
		const r = await runAdversaryReview({ brief: 'b', result: 'r', matrix: 'm' });
		expect(r.available).toBe(true);
		expect(r.findings[0].concern).toMatch(/error handling/);
		expect(r.findings[0].severity).toBe('high');
	});
	it('empty array when the model finds nothing', async () => {
		consult.mockResolvedValueOnce({ answer: '[]' });
		const { runAdversaryReview } = await import('$lib/server/routing/adversary');
		const r = await runAdversaryReview({ brief: 'b', result: 'r', matrix: 'm' });
		expect(r.available).toBe(true);
		expect(r.findings).toEqual([]);
	});
	it('TOTAL: model error → available:false, no findings, never throws', async () => {
		consult.mockRejectedValueOnce(new Error('boom'));
		const { runAdversaryReview } = await import('$lib/server/routing/adversary');
		const r = await runAdversaryReview({ brief: 'b', result: 'r', matrix: 'm' });
		expect(r.available).toBe(false);
		expect(r.findings).toEqual([]);
	});
	it('TOTAL: unparseable output → available:true, no findings (degrade, never throw)', async () => {
		consult.mockResolvedValueOnce({ answer: 'I think it looks fine honestly' });
		const { runAdversaryReview } = await import('$lib/server/routing/adversary');
		const r = await runAdversaryReview({ brief: 'b', result: 'r', matrix: 'm' });
		expect(r.findings).toEqual([]);
	});
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run tests/adversary.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/server/routing/adversary.ts`:**

```ts
// Stakes-gated AI adversary review (spec §5 REVIEWING / §8 / Contract 3 / I1).
// It can ONLY add concerns / lower confidence — never confirm, never upgrade.
// TOTAL (I7): any error/timeout/parse-failure → no concerns, proceed; never throws.
import { runConsultClaude } from '../chat/consult';

const ADV_MODEL = 'claude-haiku-4-5-20251001';
const ADV_TIMEOUT_MS = 25_000;

export interface AdversaryFinding {
	concern: string;
	severity: 'low' | 'medium' | 'high';
}

interface JobLike {
	category?: string | null;
}
interface EvidenceLike {
	fs_paths?: string[] | null;
	git_ref?: string | null;
	pr_number?: number | null;
	health_url?: string | null;
}

/** Deterministic stakes gate: review code/file/state-changing work; skip the rest. */
export function shouldReview(job: JobLike, evidence: EvidenceLike): boolean {
	if (job?.category === 'code') return true;
	if (evidence?.fs_paths && evidence.fs_paths.length > 0) return true;
	if (evidence?.git_ref) return true;
	if (evidence?.pr_number !== undefined && evidence?.pr_number !== null) return true;
	return false; // health-only / read-only → skip
}

const ADV_SYSTEM = `You are an adversarial reviewer of a coding worker's COMPLETED task. You get the original request, the worker's result, and a matrix of what was / was NOT independently verified. Your ONLY job is to surface concerns: risks, gaps, weak assumptions, missing checks, things that could go wrong, places the worker may have OVERCLAIMED — especially in the parts that could NOT be verified.

HARD RULES:
- You NEVER confirm anything, never say it's fine, never reassure, never upgrade confidence. You only raise concerns or stay silent.
- If you genuinely find nothing worth flagging, return an empty array.
- Output ONLY a JSON array, nothing else: [{"concern":"<one specific sentence>","severity":"low|medium|high"}]. No prose around it.`;

/** Run the adversary. Returns concerns + availability. Never throws (I7). */
export async function runAdversaryReview(
	args: { brief: string; result: string; matrix: string },
	timeoutMs = ADV_TIMEOUT_MS
): Promise<{ findings: AdversaryFinding[]; available: boolean }> {
	const question = `Original request: "${(args.brief || '').trim() || '(none)'}"

Worker's result:
${(args.result || '').trim() || '(none)'}

What was / wasn't verified (Go/No-Go matrix):
${(args.matrix || '').trim() || '(none)'}

Return your concerns as the JSON array now (or [] if none).`;

	const gen = runConsultClaude(question, ADV_MODEL, ADV_SYSTEM)
		.then((r) => ('answer' in r && r.answer ? r.answer : null))
		.catch(() => undefined); // undefined = the call itself failed (unavailable)

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((res) => {
		timer = setTimeout(() => res(undefined), timeoutMs);
	});
	const raw = await Promise.race([gen, timeout]);
	if (timer) clearTimeout(timer);

	if (raw === undefined) return { findings: [], available: false }; // errored/timed out
	return { findings: parseFindings(raw), available: true };
}

/** Best-effort parse of the model's JSON concern array. Bad output → []. */
function parseFindings(answer: string | null): AdversaryFinding[] {
	if (!answer) return [];
	const m = answer.match(/\[[\s\S]*\]/);
	if (!m) return [];
	try {
		const arr = JSON.parse(m[0]) as unknown;
		if (!Array.isArray(arr)) return [];
		return arr
			.filter((x): x is { concern?: unknown; severity?: unknown } => !!x && typeof x === 'object')
			.map((x) => ({
				concern: String((x as { concern?: unknown }).concern ?? '').trim(),
				severity: (['low', 'medium', 'high'].includes(
					String((x as { severity?: unknown }).severity)
				)
					? (x as { severity: string }).severity
					: 'medium') as AdversaryFinding['severity']
			}))
			.filter((f) => f.concern.length > 0);
	} catch {
		return [];
	}
}
```

- [ ] **Step 4: Run, verify pass.** `npx vitest run tests/adversary.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git add src/lib/server/routing/adversary.ts tests/adversary.test.ts && git commit -m "feat(adversary): stakes gate + total LLM reviewer (concerns only, never confirms)"`

---

## Task B1: synthesis "Reviewer concern" framing

**Files:** Modify `src/lib/server/routing/synthesize.ts`; Test `tests/adversary-synth.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/adversary-synth.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
const calls: { system?: string }[] = [];
vi.mock('$lib/server/chat/consult', () => ({
	runConsultClaude: vi.fn(async (_q: string, _m: string, system?: string) => {
		calls.push({ system });
		return { answer: 'ok' };
	})
}));
describe('synthesizeWorkerResult concerns', () => {
	it('concerns add a judgment-framed reviewer-concern instruction', async () => {
		const { synthesizeWorkerResult } = await import('$lib/server/routing/synthesize');
		await synthesizeWorkerResult({
			brief: 'b',
			result: 'r',
			concerns: ['may weaken error handling']
		});
		const s = (calls.at(-1)!.system || '').toLowerCase();
		expect(s).toMatch(/reviewer|concern|opinion|judgment|not a verified fact|flagged/);
		expect(s).toContain('may weaken error handling');
	});
	it('no concerns → no reviewer-concern instruction', async () => {
		const { synthesizeWorkerResult } = await import('$lib/server/routing/synthesize');
		await synthesizeWorkerResult({ brief: 'b', result: 'r' });
		expect(calls.at(-1)!.system || '').not.toMatch(/Reviewer concern|a reviewer flagged/i);
	});
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run tests/adversary-synth.test.ts` → FAIL.

- [ ] **Step 3: Add `concerns` to `synthesizeWorkerResult`** in `synthesize.ts` — widen the args type + build a concern instruction appended to `system`:

```ts
export async function synthesizeWorkerResult(
	args: { brief: string; result: string; posture?: 'confirmed' | 'hedge' | 'warn'; concerns?: string[] },
	timeoutMs = SYNTH_TIMEOUT_MS
): Promise<string | null> {
	const result = (args.result || '').trim();
	if (!result) return null;

	let system = SYNTH_SYSTEM + (POSTURE_FRAMING[args.posture ?? 'confirmed'] || '');
	const concerns = (args.concerns ?? []).filter((c) => c && c.trim());
	if (concerns.length) {
		system +=
			`\n\nA REVIEWER (a second-opinion AI, not a verified check) raised these concerns — present them clearly as JUDGMENT, not fact, in a short "One thing a reviewer flagged…" note at the end. Do NOT state them as confirmed problems; they are caution, not proof:\n` +
			concerns.map((c) => `- ${c}`).join('\n');
	}

	const question = `Task you handed off: "${(args.brief || '').trim() || '(no brief recorded)'}".

The worker's raw result:

${result}

Write the plain-English summary for the Captain now.`;
	// ... (unchanged: runConsultClaude(question, SYNTH_MODEL, system) + timeout race)
```

(Keep the rest of the function body identical; only `system` assembly + the args type change.)

- [ ] **Step 4: Run, verify pass.** `npx vitest run tests/adversary-synth.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git add src/lib/server/routing/synthesize.ts tests/adversary-synth.test.ts && git commit -m "feat(adversary): synthesis surfaces reviewer concerns as judgment, never fact"`

---

## Task B2: wire into `closeOutTask` + journal

**Files:** Modify `src/lib/server/completionClose.ts`, `src/lib/server/chatActivity.ts`

- [ ] **Step 1: Add `'adversary_reviewed'`** to `TASK_EVENT_ACTIONS` in `chatActivity.ts` (after `'verification_poll'`).

- [ ] **Step 2: Wire the gate + reviewer in `closeOutTask`** — after the poll block (the `pollPosture` is set) and before the `synthesizeWorkerResult` call. Build a short matrix string from the poll for the adversary, run it when gated, journal, and pass concerns to synthesis:

```ts
import { shouldReview, runAdversaryReview } from './routing/adversary';
// ...
// inside closeOutTask, after the poll block:
let concerns: string[] = [];
if (outcome === 'done' && job && text && shouldReview(job, evidence)) {
	try {
		const matrix = `posture=${pollPosture}`; // poll summary; (richer matrix string is fine)
		const adv = await runAdversaryReview({ brief: job.brief ?? '', result: text, matrix });
		concerns = adv.findings.map((f) => f.concern);
		logTaskEvent(traceId, 'adversary_reviewed', {
			available: adv.available,
			count: adv.findings.length,
			findings: adv.findings
		});
	} catch (e) {
		console.warn('[completionClose] adversary skipped:', e); // never blocks (I7)
	}
}

const summary = text
	? await synthesizeWorkerResult({
			brief: job?.brief ?? '',
			result: text,
			posture: pollPosture,
			concerns
		})
	: null;
```

> To give the adversary the _full_ matrix (not just the posture), capture the poll result in a variable in the poll block (e.g. `let pollChannels: string = ''` set to a compact channel summary) and pass it as `matrix`. Minimal version (`posture=…`) is acceptable for v1; richer is better.

- [ ] **Step 3: Typecheck + full suite.** `npm run check` (0 errors) + `npx vitest run` (all green). Behavior asserted by B3.
- [ ] **Step 4: Commit.** `git add src/lib/server/completionClose.ts src/lib/server/chatActivity.ts && git commit -m "feat(adversary): run stakes-gated review in closeOutTask, journal it, feed concerns to synthesis"`

---

## Task B3: acceptance test #6 — adversary findings labeled as concerns, not facts

**Files:** Create `tests/adversary-acceptance.test.ts`

- [ ] **Step 1: Write the acceptance test** (high-stakes code task with a worker result → adversary runs, its concern reaches synthesis as judgment, journaled; low-stakes → adversary NOT called):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB = '/tmp/sully-adv-accept-test.db';
vi.mock('$env/dynamic/private', () => ({
	env: {
		LOGUEOS_APP_MODE: 'companion',
		LOGUEOS_MEMORY_DB_PATH: DB,
		COMPANION_DISPATCH_ENABLED: 'true'
	}
}));
const synth = vi.fn(async () => 'summary');
vi.mock('$lib/server/routing/synthesize', () => ({ synthesizeWorkerResult: synth }));
const adv = vi.fn(async () => ({
	findings: [{ concern: 'may weaken error handling', severity: 'high' }],
	available: true
}));
vi.mock('$lib/server/routing/adversary', async (orig) => {
	const actual = (await orig()) as object;
	return { ...actual, runAdversaryReview: adv };
});

beforeEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
	new Database(DB).close();
	vi.resetModules();
	synth.mockClear();
	adv.mockClear();
});
afterEach(() => {
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

async function seed(traceId: string, category: string) {
	const { bootstrapCompanionDb } = await import('$lib/server/bootstrap');
	const j = await import('$lib/server/dispatchJobs');
	bootstrapCompanionDb();
	j.createJob({
		traceId,
		worker: 'claude-code',
		category,
		brief: 'do the thing',
		fingerprint: 'f',
		predictedTokens: 0,
		threadId: 't1'
	});
	j.markDispatched(traceId);
	j.markDone(traceId, 'Did the thing');
}

describe('acceptance #6 — adversary concerns are judgment, not facts', () => {
	it('high-stakes (code) → adversary runs; its concern reaches synthesis as a concern + is journaled', async () => {
		await seed('s-adv', 'code');
		const { closeOutTask } = await import('$lib/server/completionClose');
		await closeOutTask('s-adv', 'done', 'Did the thing', { fs_paths: [] });
		expect(adv).toHaveBeenCalledTimes(1);
		expect(synth).toHaveBeenCalledWith(
			expect.objectContaining({ concerns: ['may weaken error handling'] })
		);
		const { getActivityForTrace } = await import('$lib/server/chatActivity');
		expect(getActivityForTrace('s-adv', 50).some((a) => a.action === 'adversary_reviewed')).toBe(
			true
		);
	});
	it('low-stakes (general, no state-change evidence) → adversary is NOT called', async () => {
		await seed('s-low', 'general');
		const { closeOutTask } = await import('$lib/server/completionClose');
		await closeOutTask('s-low', 'done', 'just looked something up', {});
		expect(adv).not.toHaveBeenCalled();
		expect(synth).toHaveBeenCalledWith(expect.objectContaining({ concerns: [] }));
	});
});
```

- [ ] **Step 2: Run.** `npx vitest run tests/adversary-acceptance.test.ts` → PASS. Then FULL `npx vitest run` + `npm run check` → green.
- [ ] **Step 3: Commit.** `git add tests/adversary-acceptance.test.ts && git commit -m "test(adversary): acceptance #6 — concerns are judgment, not facts; gated by stakes"`

---

## Final review

- [ ] Full suite + `npm run check` green.
- [ ] Adversary review of the diff (focus: I1 — can the adversary EVER produce a fact or upgrade confidence? I7 — is it truly total/non-blocking? the stakes gate precision; the JSON parse robustness).
- [ ] Note for expand: a distinct `NEEDS_REVIEW` state for high-severity concerns; richer matrix string; model upgrade if Haiku review is too shallow. Operator live-QA + merge.
