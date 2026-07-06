# Sully Dispatcher — Hermes Learning (Part A + Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the dead Hermes routing-decision channel (Part A) and add a no-GPU learning layer (Part B) for the Sully dispatcher. Part A makes every Sully episode-close write a labeled `routing_history.jsonl` row + a `sully_episodes.jsonl` decision + a hash-chained observation, revives `hermes_apprentice.py` so it produces non-`no_decision` learning cases from Sully data, and wires the manual ingest→synthesize→apprentice pipeline onto a systemd cadence. Part B adds a local RAG decision store (sqlite-vec, mxbai-embed-large CPU embeddings), a LinUCB contextual-bandit router, and a confidence-calibration step — all CPU, all improving from the first operator approve/override.
**Architecture:** Two repos. LogueOS-Companion (SvelteKit adapter-node, Svelte 5 runes, TypeScript, better-sqlite3, vitest) owns the episode-close writer, the new companion-native learning flag, the RAG store, the bandit, and the calibrator. LogueOS-Orchestrator (Python 3.12, append-only JSONL + hash-chained `agent_decisions.jsonl`, unittest) owns the additive `load_sully_episodes()` in `hermes_apprentice.py`, the `synthesize_lessons` partition guard, and the systemd cadence units. The companion writes the Orchestrator's append-only files via raw `fs.appendFileSync` (routing*history, sully_episodes) and via the existing hash-chained `emit_observation` write surface (agent_decisions).
**Tech Stack:** TypeScript (`$lib/server/*.ts`, vitest `tests/\*_/_.test.ts`), Python 3.12 (`tools/_.py`, `tests/test_\*.py`, unittest), better-sqlite3 (companion.db + a new `sully_rag.db`), sqlite-vec (vec0 virtual table), Ollama `mxbai-embed-large:latest` embeddings (CPU), systemd oneshot service + timer.

---

## File Structure

| File                                               | Repo         | Create / Modify | One responsibility                                                                                                                                                                                                            |
| -------------------------------------------------- | ------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/server/config.ts`                         | Companion    | Modify          | Add the companion-native `learningEnabled` flag to `runMode` (NOT `_wired`); driven by new env `COMPANION_LEARNING_ENABLED`.                                                                                                  |
| `tests/run-mode.test.ts`                           | Companion    | Modify          | Assert `learningEnabled` matrix: companion+flag-on → true, companion default → false, wired → false.                                                                                                                          |
| `src/lib/server/sully_episode_close.ts`            | Companion    | Create          | The episode-close writer: append labeled `routing_history.jsonl` row (W2 intent shape, `SULLY-<n>` namespace) + `sully_episodes.jsonl` decision + hash-chained observation via a child-process call to `emit_observation.py`. |
| `tests/sully-episode-close.test.ts`                | Companion    | Create          | Verify the three writes: routing_history row shape + `SULLY-<n>` regex conformance, sully_episodes action mapping, observation invocation.                                                                                    |
| `tools/hermes_apprentice.py`                       | Orchestrator | Modify          | Add additive `load_sully_episodes()` that merges Sully decision rows into `decided_map` by `task_identifier`. Zero change to `_classify_signal` / `_actual_worker`.                                                           |
| `tests/test_hermes_apprentice.py`                  | Orchestrator | Modify          | Add a `LoadSullyEpisodesTest` proving a Sully episode yields a non-`no_decision` case.                                                                                                                                        |
| `tools/synthesize_lessons.py`                      | Orchestrator | Modify          | Add a `source='sully'` partition guard so Sully chat/persona observations are bucketed and skipped, never promoted into team lessons.                                                                                         |
| `tests/test_synthesize_lessons_sully_partition.py` | Orchestrator | Create          | Prove `source='sully'` observations are excluded from team-lesson synthesis.                                                                                                                                                  |
| `linux/systemd/logueos-companion-learning.service` | Orchestrator | Create          | Oneshot: run ingest_memory → synthesize_lessons → hermes_apprentice in sequence.                                                                                                                                              |
| `linux/systemd/logueos-companion-learning.timer`   | Orchestrator | Create          | Hourly cadence for the learning service.                                                                                                                                                                                      |
| `tools/run_companion_learning.py`                  | Orchestrator | Create          | Sequenced runner the systemd service calls (ingest → synthesize → apprentice), fail-soft per stage.                                                                                                                           |
| `tests/test_run_companion_learning.py`             | Orchestrator | Create          | Prove the runner sequences the three stages and tolerates a missing synthesize (Ollama-down) stage.                                                                                                                           |
| `src/lib/server/sully_rag_store.ts`                | Companion    | Create          | Part B: local RAG decision store (`sully_rag.db`, sqlite-vec vec0) + mxbai-embed-large CPU embeddings + k-NN retrieval of past decisions.                                                                                     |
| `tests/sully-rag-store.test.ts`                    | Companion    | Create          | Prove a logged decision is retrievable by k-NN with a stubbed embedder.                                                                                                                                                       |
| `src/lib/server/sully_bandit.ts`                   | Companion    | Create          | Part B: LinUCB contextual-bandit router; arms `{handle-locally, escalate}`; reward approve(+1)/override(0); recency decay.                                                                                                    |
| `tests/sully-bandit.test.ts`                       | Companion    | Create          | Prove the bandit shifts arm preference after repeated approve vs override rewards.                                                                                                                                            |
| `src/lib/server/sully_calibration.ts`              | Companion    | Create          | Part B: temperature/Platt confidence calibration fit on logged decisions; produces a deferral threshold.                                                                                                                      |
| `tests/sully-calibration.test.ts`                  | Companion    | Create          | Prove temperature scaling monotonically maps raw confidence and that a fitted threshold separates approve/override.                                                                                                           |
| `package.json`                                     | Companion    | Modify          | Add `sqlite-vec` dependency.                                                                                                                                                                                                  |

**Gating legend (per spec §10 Phase 3, §12 Phase-3 acceptance):**

- **STANDALONE-BUILDABLE NOW:** Tasks A0, A1, A2, A3, A4, A5, B6, B7, B8. All use synthetic/fixture episodes or stubbed embedders — none require live Phase-1 episode capture to be merged first.
- **GATED on Phase-1 episode capture (§10 Phase 1 `pending_jobs` + episode-close trigger):** The runtime _wiring_ of `sully_episode_close.ts` into the live dispatch close path, and `sully_rag_store.ts` / `sully_bandit.ts` being called at live decision time. Those call-sites land in the Phase-1 plan; this plan delivers the modules + tests so they are ready. Each task below marks its gating status.

---

## Tasks

### Task A0 — Companion-native `learningEnabled` flag (STANDALONE NOW)

Spec §4.10 requires a NEW companion-native flag, NOT `_wired`. `observationsEnabled` is `_wired` (OFF in companion mode), so Sully learning writes would be blocked if we reused it. `config.ts:143-153` is the single source of truth for run-mode booleans.

**Files:** modify `src/lib/server/config.ts`; modify `tests/run-mode.test.ts`

- [ ] Write the failing test. Append to `tests/run-mode.test.ts` inside `describe('runMode', ...)`:

```ts
it('enables Sully learning only in companion mode with the opt-in flag', async () => {
	vi.resetModules();
	vi.stubEnv('LOGUEOS_APP_MODE', 'companion');
	vi.stubEnv('COMPANION_LEARNING_ENABLED', 'true');
	vi.doMock('$env/dynamic/private', () => ({
		env: { LOGUEOS_APP_MODE: 'companion', COMPANION_LEARNING_ENABLED: 'true' }
	}));
	const { runMode } = await import('$lib/server/config');
	expect(runMode).toMatchObject({ companion: true, learningEnabled: true });
});

it('keeps Sully learning OFF in companion mode by default', async () => {
	await expect(loadRunMode('companion')).resolves.toMatchObject({
		companion: true,
		learningEnabled: false
	});
});

it('keeps Sully learning OFF in wired mode regardless of flag', async () => {
	vi.resetModules();
	vi.stubEnv('LOGUEOS_APP_MODE', 'wired');
	vi.stubEnv('COMPANION_LEARNING_ENABLED', 'true');
	vi.doMock('$env/dynamic/private', () => ({
		env: { LOGUEOS_APP_MODE: 'wired', COMPANION_LEARNING_ENABLED: 'true' }
	}));
	const { runMode } = await import('$lib/server/config');
	expect(runMode).toMatchObject({ companion: false, learningEnabled: false });
});
```

- [ ] Run it (expect FAIL — `learningEnabled` is undefined):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/run-mode.test.ts
```

Expected: FAIL, `expected ... to match object { ... learningEnabled: true }` (received `undefined`).

- [ ] Minimal implementation. In `src/lib/server/config.ts`, add a `getEnv` read inside the `serverConfig` object (after the `enableWebPush` line, before `orchestratorEnvPath`):

```ts
		// Companion-native learning opt-in. Distinct from `_wired` — Sully learning
		// writes (routing_history + sully_episodes + observations) must work in
		// companion mode, where `observationsEnabled` is OFF. Default OFF so the
		// fork stays silent until episode capture (Phase 1) is live.
		companionLearningEnabled: getEnv('COMPANION_LEARNING_ENABLED', 'false') === 'true',
```

Then add to the `runMode` object (after the `killSwitchEnabled` line, inside the `as const` block, fixing the trailing comma on the line above):

```ts
		killSwitchEnabled: _wired, // read the system_halt kernel artifact
		// Companion-native: Sully learning data path (Part A/B). True ONLY in
		// companion mode AND with the opt-in env flag. Never piggybacks on _wired.
		learningEnabled: !_wired && serverConfig.companionLearningEnabled
```

- [ ] Run it (expect PASS):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/run-mode.test.ts
```

Expected: PASS, all run-mode cases green.

- [ ] Commit:

```bash
cd /home/dreighto/dev/LogueOS-Companion && git checkout -b feat/sully-hermes-learning 2>/dev/null || git checkout feat/sully-hermes-learning; git add src/lib/server/config.ts tests/run-mode.test.ts && git commit -m "feat(companion): add companion-native learningEnabled run-mode flag

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task A1 — `sully_episodes.jsonl` schema + decision writer (STANDALONE NOW)

Spec §4.10 Part A.2: paired operator-decision record to a NEW `data/sully_episodes.jsonl`. Action map: approve→`a`, skip→`t`, correct-to-X→`{c/u/x/g}`, generic-correct→`o`. The action codes MUST match `hermes_apprentice.py:41-56` (`_ACTION_TO_WORKER`, `_OVERRIDE_ACTIONS`, `_TRIAGE_ACTIONS`, `_APPROVE_ACTION`) verbatim so `_classify_signal` (`hermes_apprentice.py:305-316`) classifies them with zero changes. We build the action-mapping + writer here; routing_history + observation writes land in A2.

**Files:** create `src/lib/server/sully_episode_close.ts`; create `tests/sully-episode-close.test.ts`

- [ ] Write the failing test. Create `tests/sully-episode-close.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapOperatorReactionToAction, writeSullyDecision } from '$lib/server/sully_episode_close';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sully-ep-'));
});
afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mapOperatorReactionToAction', () => {
	it('maps approve to a', () => expect(mapOperatorReactionToAction('approve')).toBe('a'));
	it('maps skip to t', () => expect(mapOperatorReactionToAction('skip')).toBe('t'));
	it('maps correct-to-claude-code to c', () =>
		expect(mapOperatorReactionToAction('correct', 'claude-code')).toBe('c'));
	it('maps correct-to-gemini to g', () =>
		expect(mapOperatorReactionToAction('correct', 'gemini')).toBe('g'));
	it('maps generic correct (no worker) to o', () =>
		expect(mapOperatorReactionToAction('correct')).toBe('o'));
});

describe('writeSullyDecision', () => {
	it('appends a regex-conforming SULLY-<n> decision row', () => {
		const target = path.join(tmpDir, 'sully_episodes.jsonl');
		const row = writeSullyDecision(
			{ episodeNumber: 7, reaction: 'approve', correctedWorker: null, traceId: 'tr-7' },
			target
		);
		expect(row.task_identifier).toBe('SULLY-7');
		expect(/^[A-Z]+-\d+$/.test(row.task_identifier)).toBe(true);
		expect(row.action).toBe('a');
		expect(row.action_label).toBe('Approve');
		expect(row.trace_id).toBe('tr-7');
		expect(typeof row.decided_at).toBe('string');
		const lines = fs.readFileSync(target, 'utf-8').trim().split('\n');
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).task_identifier).toBe('SULLY-7');
	});

	it('is append-only (second write keeps the first row)', () => {
		const target = path.join(tmpDir, 'sully_episodes.jsonl');
		writeSullyDecision(
			{ episodeNumber: 1, reaction: 'approve', correctedWorker: null, traceId: 'a' },
			target
		);
		writeSullyDecision(
			{ episodeNumber: 2, reaction: 'skip', correctedWorker: null, traceId: 'b' },
			target
		);
		const lines = fs.readFileSync(target, 'utf-8').trim().split('\n');
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]).action).toBe('t');
	});
});
```

- [ ] Run it (expect FAIL — module does not exist):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/sully-episode-close.test.ts
```

Expected: FAIL, `Failed to resolve import "$lib/server/sully_episode_close"`.

- [ ] Minimal implementation. Create `src/lib/server/sully_episode_close.ts`:

```ts
// Sully episode-close writer (spec §4.10 Part A). On episode close, Sully
// writes — append-only — into the Orchestrator's data/ dir:
//   1. a labeled routing_history.jsonl row (W2 intent shape, SULLY-<n>)   [A2]
//   2. a sully_episodes.jsonl operator-decision record                    [A1]
//   3. a hash-chained observation via emit_observation.py                 [A2]
// This file (A1) defines the action mapping + the decision-row writer.
//
// Action codes mirror tools/hermes_apprentice.py:41-56 EXACTLY so the
// apprentice's tested _classify_signal classifies Sully rows unchanged:
//   a=Approve, t=Triage/Skip, c=claude-code, u=cursor, x=codex, g=gemini,
//   o=generic override/correct.

import fs from 'node:fs';

export type OperatorReaction = 'approve' | 'skip' | 'correct';

/** Operator-reaction → pending_callbacks action code (hermes_apprentice contract). */
export function mapOperatorReactionToAction(
	reaction: OperatorReaction,
	correctedWorker?: string | null
): string {
	if (reaction === 'approve') return 'a';
	if (reaction === 'skip') return 't';
	// reaction === 'correct'
	switch (correctedWorker) {
		case 'claude-code':
			return 'c';
		case 'cursor':
			return 'u';
		case 'codex':
			return 'x';
		case 'gemini':
			return 'g';
		default:
			return 'o'; // generic correct — worker unknown
	}
}

const ACTION_LABELS: Record<string, string> = {
	a: 'Approve',
	t: 'Triage',
	c: 'claude-code',
	u: 'cursor',
	x: 'codex',
	g: 'gemini',
	o: 'Override'
};

export interface SullyDecisionInput {
	episodeNumber: number;
	reaction: OperatorReaction;
	correctedWorker: string | null;
	traceId: string;
}

export interface SullyDecisionRow {
	task_identifier: string;
	action: string;
	action_label: string;
	decided_at: string;
	trace_id: string;
}

/**
 * Append one operator-decision record to sully_episodes.jsonl. Raw fs append
 * (append-only invariant — never read-modify-write). Returns the row written.
 */
export function writeSullyDecision(
	input: SullyDecisionInput,
	targetPath: string
): SullyDecisionRow {
	const action = mapOperatorReactionToAction(input.reaction, input.correctedWorker);
	const row: SullyDecisionRow = {
		task_identifier: `SULLY-${input.episodeNumber}`,
		action,
		action_label: ACTION_LABELS[action] ?? 'Override',
		decided_at: new Date().toISOString(),
		trace_id: input.traceId
	};
	fs.appendFileSync(targetPath, JSON.stringify(row) + '\n', 'utf-8');
	return row;
}
```

- [ ] Run it (expect PASS):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/sully-episode-close.test.ts
```

Expected: PASS, all `mapOperatorReactionToAction` + `writeSullyDecision` cases green.

- [ ] Commit:

```bash
cd /home/dreighto/dev/LogueOS-Companion && git add src/lib/server/sully_episode_close.ts tests/sully-episode-close.test.ts && git commit -m "feat(companion): sully_episodes.jsonl decision writer + action mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task A2 — routing_history.jsonl row + observation emit on episode close (STANDALONE NOW for the writer; runtime wiring GATED on Phase-1 episode capture)

Spec §4.10 Part A.1 + A.4. The labeled `routing_history.jsonl` row mirrors the live W2 shape (verified from `data/routing_history.jsonl`: `timestamp, trace_id, task_id, task_identifier, extracted_signals{task_type,surface_keywords,touches_paths,research_signal}, ranked_candidates[], chosen_worker, confidence, risk, operator_override_flag, outcome, ...`). The observation rides the SAME hash-chained `agent_decisions.jsonl` pipeline via `emit_observation.py` (Orchestrator) called as a child process with `LOGUEOS_PROJECT_ID=logueos-companion`, `source`/`observation_kind` set per high-signal episode. We do NOT reuse the companion's `observation_emit.ts` (it writes directly to `observations` and is gated on `observationsEnabled=_wired`, OFF) — the spec requires the hash-chained `agent_decisions.jsonl` path so synthesize/ingest pick it up.

**Files:** modify `src/lib/server/sully_episode_close.ts`; modify `tests/sully-episode-close.test.ts`

- [ ] Write the failing test. Append to `tests/sully-episode-close.test.ts`:

```ts
import {
	buildRoutingHistoryRow,
	observationKindForReaction
} from '$lib/server/sully_episode_close';

describe('buildRoutingHistoryRow', () => {
	it('produces a W2-shaped row with a SULLY-<n> task_identifier', () => {
		const row = buildRoutingHistoryRow({
			episodeNumber: 12,
			traceId: 'tr-12',
			taskId: 'uuid-12',
			chosenWorker: 'claude-code',
			confidence: 0.82,
			risk: 'medium',
			taskType: 'bug',
			surfaceKeywords: ['crash'],
			touchesPaths: ['src/x.ts'],
			researchSignal: false,
			operatorOverride: false,
			outcome: 'success'
		});
		expect(row.task_identifier).toBe('SULLY-12');
		expect(/^[A-Z]+-\d+$/.test(row.task_identifier)).toBe(true);
		expect(row.chosen_worker).toBe('claude-code');
		expect(row.extracted_signals.task_type).toBe('bug');
		expect(row.extracted_signals.surface_keywords).toEqual(['crash']);
		expect(Array.isArray(row.ranked_candidates)).toBe(true);
		expect(row.w2_workflow_version).toBe('sully-companion-v1');
		expect(typeof row.timestamp).toBe('string');
	});
});

describe('observationKindForReaction', () => {
	it('maps correct/skip to routing-correction', () => {
		expect(observationKindForReaction('correct')).toBe('routing-correction');
		expect(observationKindForReaction('skip')).toBe('routing-correction');
	});
	it('maps approve+success to what-worked', () => {
		expect(observationKindForReaction('approve', 'success')).toBe('what-worked');
	});
	it('maps approve+failure to what-didnt-work', () => {
		expect(observationKindForReaction('approve', 'failed')).toBe('what-didnt-work');
	});
});
```

- [ ] Run it (expect FAIL — exports do not exist):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/sully-episode-close.test.ts
```

Expected: FAIL, `buildRoutingHistoryRow is not a function` / import resolves but named exports missing.

- [ ] Minimal implementation. Append to `src/lib/server/sully_episode_close.ts`:

```ts
import { spawn } from 'node:child_process';

export interface RoutingHistoryInput {
	episodeNumber: number;
	traceId: string;
	taskId: string;
	chosenWorker: string;
	confidence: number;
	risk: string;
	taskType: string;
	surfaceKeywords: string[];
	touchesPaths: string[];
	researchSignal: boolean;
	operatorOverride: boolean;
	outcome: string;
}

export interface RoutingHistoryRow {
	timestamp: string;
	trace_id: string;
	task_id: string;
	task_identifier: string;
	extracted_signals: {
		task_type: string;
		surface_keywords: string[];
		touches_paths: string[];
		research_signal: boolean;
	};
	ranked_candidates: { worker: string; score: number; reasoning: string }[];
	chosen_worker: string;
	confidence: number;
	risk: string;
	operator_override_flag: boolean;
	outcome: string;
	proposed_model_version: string | null;
	w2_workflow_version: string;
}

/** Build the labeled routing_history row mirroring the live W2 intent shape. */
export function buildRoutingHistoryRow(input: RoutingHistoryInput): RoutingHistoryRow {
	return {
		timestamp: new Date().toISOString(),
		trace_id: input.traceId,
		task_id: input.taskId,
		task_identifier: `SULLY-${input.episodeNumber}`,
		extracted_signals: {
			task_type: input.taskType,
			surface_keywords: input.surfaceKeywords,
			touches_paths: input.touchesPaths,
			research_signal: input.researchSignal
		},
		ranked_candidates: [
			{ worker: input.chosenWorker, score: input.confidence, reasoning: 'sully-decision-gate' }
		],
		chosen_worker: input.chosenWorker,
		confidence: input.confidence,
		risk: input.risk,
		operator_override_flag: input.operatorOverride,
		outcome: input.outcome,
		proposed_model_version: null,
		w2_workflow_version: 'sully-companion-v1'
	};
}

/** Append the routing_history row, raw fs append (append-only invariant). */
export function writeRoutingHistory(row: RoutingHistoryRow, targetPath: string): void {
	fs.appendFileSync(targetPath, JSON.stringify(row) + '\n', 'utf-8');
}

/** High-signal observation_kind for the agent_decisions.jsonl emit. */
export function observationKindForReaction(
	reaction: OperatorReaction,
	outcome?: string
): 'routing-correction' | 'what-worked' | 'what-didnt-work' {
	if (reaction === 'correct' || reaction === 'skip') return 'routing-correction';
	return outcome === 'failed' ? 'what-didnt-work' : 'what-worked';
}

export interface ObservationEmitInput {
	traceId: string;
	episodeNumber: number;
	text: string;
	observationKind: 'routing-correction' | 'what-worked' | 'what-didnt-work';
	emitScriptPath: string; // absolute path to Orchestrator tools/emit_observation.py
	pythonBin: string; // absolute path to the Orchestrator venv python
}

/**
 * Emit a hash-chained observation by spawning emit_observation.py. The script
 * reads JSON on stdin, appends to agent_decisions.jsonl via append_chained, and
 * is the ONLY sanctioned writer for that hash-chained file. project_id +
 * source='sully' partition the row for the synthesize_lessons guard (A5).
 */
export function emitSullyObservation(input: ObservationEmitInput): Promise<{ ok: boolean }> {
	return new Promise((resolve) => {
		const payload = JSON.stringify({
			kind: 'observation',
			project_id: 'logueos-companion',
			trace_id: input.traceId,
			ticket_id: `SULLY-${input.episodeNumber}`,
			observation_kind: input.observationKind,
			text: input.text,
			task_shape: ['sully', 'dispatch-episode'],
			// `source` is a companion-side partition tag; emit_observation passes
			// unknown extra keys through unchanged onto the chained row.
			source: 'sully'
		});
		const child = spawn(input.pythonBin, [input.emitScriptPath], {
			env: { ...process.env, LOGUEOS_PROJECT_ID: 'logueos-companion' }
		});
		child.stdin.write(payload);
		child.stdin.end();
		child.on('error', () => resolve({ ok: false }));
		child.on('close', (code) => resolve({ ok: code === 0 }));
	});
}
```

- [ ] Run it (expect PASS):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/sully-episode-close.test.ts
```

Expected: PASS, including the new `buildRoutingHistoryRow` + `observationKindForReaction` describes.

- [ ] Commit:

```bash
cd /home/dreighto/dev/LogueOS-Companion && git add src/lib/server/sully_episode_close.ts tests/sully-episode-close.test.ts && git commit -m "feat(companion): routing_history row builder + hash-chained observation emit on episode close

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> **Runtime-wiring note (GATED on Phase-1):** The call that invokes `writeRoutingHistory` + `writeSullyDecision` + `emitSullyObservation` from the live dispatch episode-close path (resolving `serverConfig`-derived Orchestrator `data/` paths + the venv python) is added in the Phase-1 episode-capture plan, behind `runMode.learningEnabled`. This task delivers the pure, unit-tested writer functions.

---

### Task A3 — Additive `load_sully_episodes()` in hermes_apprentice.py (STANDALONE NOW)

Spec §4.10 Part A.3. Add a small loader that reads `data/sully_episodes.jsonl` and merges its decided rows into `decided_map` keyed by `task_identifier` — exactly the structure `load_pending_callbacks` returns at `hermes_apprentice.py:203-241`. ZERO change to `_classify_signal` (line 305) or `_actual_worker` (line 319): a Sully row carries the same `action`/`action_label`/`decided_at` fields a `decided` callback row carries, so the existing classifier handles it unchanged. Sully episodes only have `routing_history` rows (no `pending_callbacks` rows), so `decided_map` is the join surface.

**Files:** modify `tools/hermes_apprentice.py`; modify `tests/test_hermes_apprentice.py`

- [ ] Write the failing test. Append to `tests/test_hermes_apprentice.py` (after `RunIntegrationTest`):

```python
# ---------------------------------------------------------------------------
# load_sully_episodes — Sully decision channel (spec §4.10 Part A)
# ---------------------------------------------------------------------------

_RH_ROW_SULLY = {
    "timestamp": "2026-05-31T10:00:00.000Z",
    "trace_id": "tr-7",
    "task_id": "uuid-sully-7",
    "task_identifier": "SULLY-7",
    "extracted_signals": {"task_type": "bug", "surface_keywords": ["crash"]},
    "ranked_candidates": [{"worker": "claude-code", "score": 0.82, "reasoning": "sully-decision-gate"}],
    "chosen_worker": "claude-code",
    "confidence": 0.82,
    "risk": "medium",
    "operator_override_flag": False,
    "outcome": "success",
    "proposed_model_version": None,
    "w2_workflow_version": "sully-companion-v1",
}

_SULLY_EPISODE_APPROVE = {
    "task_identifier": "SULLY-7",
    "action": "a",
    "action_label": "Approve",
    "decided_at": "2026-05-31T10:01:00.000Z",
    "trace_id": "tr-7",
}

_SULLY_EPISODE_OVERRIDE = {
    "task_identifier": "SULLY-8",
    "action": "g",
    "action_label": "gemini",
    "decided_at": "2026-05-31T10:02:00.000Z",
    "trace_id": "tr-8",
}


class LoadSullyEpisodesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mod = _import_module()

    def test_loads_decided_rows_keyed_by_task_identifier(self) -> None:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".jsonl", delete=False, encoding="utf-8"
        ) as fh:
            fh.write(json.dumps(_SULLY_EPISODE_APPROVE) + "\n")
            fh.write(json.dumps(_SULLY_EPISODE_OVERRIDE) + "\n")
            path = fh.name
        try:
            decided = self.mod.load_sully_episodes(path)
            self.assertIn("SULLY-7", decided)
            self.assertEqual(decided["SULLY-7"]["action"], "a")
            self.assertEqual(decided["SULLY-8"]["action"], "g")
        finally:
            os.unlink(path)

    def test_missing_file_returns_empty(self) -> None:
        decided = self.mod.load_sully_episodes("/nonexistent/sully_episodes.jsonl")
        self.assertEqual(decided, {})

    def test_latest_decided_wins_per_task_identifier(self) -> None:
        early = {**_SULLY_EPISODE_APPROVE, "decided_at": "2026-05-31T10:00:00Z", "action": "a"}
        late = {**_SULLY_EPISODE_APPROVE, "decided_at": "2026-05-31T11:00:00Z", "action": "o"}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".jsonl", delete=False, encoding="utf-8"
        ) as fh:
            fh.write(json.dumps(early) + "\n")
            fh.write(json.dumps(late) + "\n")
            path = fh.name
        try:
            decided = self.mod.load_sully_episodes(path)
            self.assertEqual(decided["SULLY-7"]["action"], "o")
        finally:
            os.unlink(path)

    def test_sully_episode_yields_non_no_decision_case(self) -> None:
        """The whole point: a Sully episode produces a classified (non-no_decision) case."""
        decided_map = {"SULLY-7": _SULLY_EPISODE_APPROVE}
        case = self.mod.build_case(_RH_ROW_SULLY, [], decided_map.get("SULLY-7"))
        self.assertEqual(case["learning_signal"], "confirmed")
        self.assertNotEqual(case["learning_signal"], "no_decision")
        self.assertEqual(case["delta"]["actual_worker"], "claude-code")

    def test_sully_override_episode_classified_as_override(self) -> None:
        case = self.mod.build_case(
            {**_RH_ROW_SULLY, "task_identifier": "SULLY-8"}, [], _SULLY_EPISODE_OVERRIDE
        )
        self.assertEqual(case["learning_signal"], "override")
        self.assertEqual(case["delta"]["actual_worker"], "gemini")
```

- [ ] Run it (expect FAIL — `load_sully_episodes` missing):

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && python -m pytest tests/test_hermes_apprentice.py::LoadSullyEpisodesTest -q
```

Expected: FAIL, `AttributeError: module ... has no attribute 'load_sully_episodes'` (the `build_case` sub-tests will pass if you isolate them, but the loader tests fail).

- [ ] Minimal implementation. In `tools/hermes_apprentice.py`, add the loader directly after `load_pending_callbacks` (after line 241):

```python
def load_sully_episodes(path: str) -> dict[str, dict]:
    """Load data/sully_episodes.jsonl into a decided_map keyed by task_identifier.

    Sully writes one operator-decision record per episode close (spec §4.10
    Part A). The row carries the SAME action/action_label/decided_at fields a
    pending_callbacks `decided` row carries, so the existing _classify_signal /
    _actual_worker handle it with no change. Missing file → empty (Sully
    learning may not be enabled yet). Latest decided_at wins per task_identifier.
    """
    decided_map: dict[str, dict] = {}
    if not os.path.exists(path):
        return decided_map
    with open(path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                print(
                    f"[hermes_apprentice] warning: bad JSON on line {lineno} of {path}",
                    file=sys.stderr,
                )
                continue
            ticket = row.get("task_identifier")
            if not ticket:
                continue
            ts = row.get("decided_at", "")
            existing = decided_map.get(ticket)
            if existing is None or ts > existing.get("decided_at", ""):
                decided_map[ticket] = row
    return decided_map
```

Then wire it into `run()` so the Sully decisions merge into `decided_map`. In `run()` after line 508 (`intent_map, decided_map = load_pending_callbacks(callbacks_path)`), add:

```python
    # Sully decision channel (spec §4.10 Part A) — merge Sully episode decisions
    # into decided_map by task_identifier. Additive; pending_callbacks rows win
    # on key collision only if newer (Sully uses a disjoint SULLY-<n> namespace,
    # so collisions are not expected).
    sully_path = sully_episodes_path or _default_path("sully_episodes.jsonl")
    sully_decided = load_sully_episodes(sully_path)
    for ticket, row in sully_decided.items():
        existing = decided_map.get(ticket)
        if existing is None or row.get("decided_at", "") > existing.get("decided_at", ""):
            decided_map[ticket] = row
```

Add the `sully_episodes_path` parameter to `run()` (after `supervision_path` in the signature at line 501):

```python
    supervision_path: str | None = None,
    sully_episodes_path: str | None = None,
```

And pass it from `main()` (after the `supervision_path=supervision_path,` arg at line 642):

```python
        supervision_path=supervision_path,
        sully_episodes_path=_default_path("sully_episodes.jsonl"),
```

- [ ] Run it (expect PASS):

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && python -m pytest tests/test_hermes_apprentice.py -q
```

Expected: PASS, all existing tests + the new `LoadSullyEpisodesTest` green (proving `_classify_signal` is untouched).

- [ ] Commit:

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && git checkout -b feat/sully-hermes-learning 2>/dev/null || git checkout feat/sully-hermes-learning; git add tools/hermes_apprentice.py tests/test_hermes_apprentice.py && git commit -m "feat(hermes): additive load_sully_episodes() revives the dead decision channel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task A5 — synthesize_lessons partition guard for source='sully' (STANDALONE NOW)

Spec §4.10 "Partition discipline": `synthesize_lessons` must bucket/skip Sully rows so chat/persona noise isn't promoted into team lessons. The `observations` table carries `source` (added lazily in `observation_emit.ts:65-77`; for the hash-chained path, A2's emit passes `source='sully'` through onto the chained row, and `ingest_memory.py` already maps observation rows into the table — but `ingest_memory.py:50-79` does NOT currently persist `source`). So the guard must (a) make `load_new_observations` aware of `source` and (b) exclude `source='sully'` from team synthesis. We do A5 before A4 because the cadence runner (A4) must call the guarded synthesize.

**Files:** modify `tools/synthesize_lessons.py`; create `tests/test_synthesize_lessons_sully_partition.py`

- [ ] Write the failing test. Create `tests/test_synthesize_lessons_sully_partition.py`:

```python
"""source='sully' partition guard for synthesize_lessons (spec §4.10)."""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "tools" / "synthesize_lessons.py"


def _import_module():
    spec = importlib.util.spec_from_file_location("synthesize_lessons_under_test", str(MODULE_PATH))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["synthesize_lessons_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


class _FakeClusterer:
    """Records which project_ids it was asked to cluster; returns one lesson each."""

    def __init__(self):
        self.seen_projects: list[str] = []

    def cluster(self, project_id, observations):
        self.seen_projects.append(project_id)
        return [
            {
                "lesson_text": f"lesson for {project_id}",
                "task_shape_tags": ["t"],
                "source_observation_ids": [o.observation_id for o in observations],
            }
        ]


def _seed_db(path: str) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE observations (
            observation_id TEXT PRIMARY KEY, trace_id TEXT, ticket_id TEXT,
            project_id TEXT, observation_kind TEXT, text TEXT, task_shape TEXT,
            timestamp TEXT, source TEXT
        )"""
    )
    conn.executemany(
        "INSERT INTO observations (observation_id, project_id, observation_kind, text, task_shape, source) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            ("obs-team", "project-miru", "what-worked", "team lesson body text here", "[]", None),
            ("obs-sully", "logueos-companion", "what-worked", "sully chat body text here", "[]", "sully"),
        ],
    )
    conn.commit()
    conn.close()


class SullyPartitionGuardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mod = _import_module()

    def test_sully_sourced_observations_excluded_from_synthesis(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = f.name
        _seed_db(db_path)
        conn = sqlite3.connect(db_path)
        try:
            clusterer = _FakeClusterer()
            summary = self.mod.synthesize(conn, clusterer, full=True)
            # Only the non-sully project should have been clustered.
            self.assertIn("project-miru", clusterer.seen_projects)
            self.assertNotIn("logueos-companion", clusterer.seen_projects)
            # The sully observation is still marked consumed so it is not reprocessed.
            consumed = {
                r[0] for r in conn.execute("SELECT observation_id FROM synthesis_consumed")
            }
            self.assertIn("obs-sully", consumed)
        finally:
            conn.close()
            Path(db_path).unlink()
```

- [ ] Run it (expect FAIL — Sully rows are currently clustered):

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && python -m pytest tests/test_synthesize_lessons_sully_partition.py -q
```

Expected: FAIL, `AssertionError: 'logueos-companion' unexpectedly found in [...]` (the guard does not exist yet; `load_new_observations` also does not select `source`).

- [ ] Minimal implementation. In `tools/synthesize_lessons.py`:

Add `source` to the `Observation` dataclass (after `ticket_id`, line 118):

```python
    ticket_id: str | None
    source: str | None = None
```

Change the `load_new_observations` SELECT (line 131-134) to include `source`, and partition out Sully rows. Replace the loop body so the SELECT and append carry `source`, and skip `source='sully'` rows from the clustering set while still marking them consumed:

```python
def load_new_observations(conn: sqlite3.Connection, *, full: bool) -> list[Observation]:
    """Observations not yet recorded in synthesis_consumed (or all, if full).

    source='sully' rows are partition-skipped: never clustered into TEAM
    lessons (spec §4.10), but still returned so synthesize() marks them
    consumed and they are not reprocessed forever.
    """
    consumed: set[str] = set()
    if not full:
        consumed = {row[0] for row in conn.execute("SELECT observation_id FROM synthesis_consumed")}
    has_source = any(c[1] == "source" for c in conn.execute("PRAGMA table_info(observations)"))
    cols = "observation_id, project_id, observation_kind, text, task_shape, ticket_id"
    cols += ", source" if has_source else ""
    out: list[Observation] = []
    for row in conn.execute(f"SELECT {cols} FROM observations"):
        obs_id = row[0]
        if not obs_id or obs_id in consumed:
            continue
        try:
            tags = json.loads(row[4]) if row[4] else []
        except (json.JSONDecodeError, TypeError):
            tags = []
        out.append(
            Observation(
                observation_id=obs_id,
                project_id=row[1] or "unknown",
                observation_kind=row[2] or "observation",
                text=row[3] or "",
                task_shape=tags if isinstance(tags, list) else [],
                ticket_id=row[5],
                source=row[6] if has_source and len(row) > 6 else None,
            )
        )
    return out
```

Then in `synthesize()`, partition before grouping by project. Replace the `by_project` build (lines 340-343) with:

```python
    # Partition discipline (spec §4.10): source='sully' rows never feed TEAM
    # lesson clustering, but are still marked consumed below so they don't
    # accumulate as perpetual "new" rows.
    cluster_obs = [o for o in new_obs if o.source != "sully"]
    by_project: dict[str, list[Observation]] = {}
    for obs in cluster_obs:
        by_project.setdefault(obs.project_id, []).append(obs)
    summary["projects"] = len(by_project)
```

The existing "mark every processed observation consumed" loop (lines 403-409) iterates `new_obs` (the full set incl. Sully rows), so Sully rows get marked consumed with `lesson_id=NULL` — no change needed there.

- [ ] Run it (expect PASS):

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && python -m pytest tests/test_synthesize_lessons_sully_partition.py -q
```

Expected: PASS — `project-miru` clustered, `logueos-companion` skipped, `obs-sully` consumed.

- [ ] Run the existing synthesize tests to confirm no regression:

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && python -m pytest tests/ -k synthesize -q
```

Expected: PASS (no regression in existing synthesize tests).

- [ ] Commit:

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && git add tools/synthesize_lessons.py tests/test_synthesize_lessons_sully_partition.py && git commit -m "feat(synthesize): partition guard skips source='sully' rows from team lessons

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task A4 — Cadence runner + systemd timer (STANDALONE NOW)

Spec §4.10 Part A.5: `ingest_memory.py` + `synthesize_lessons.py` + `hermes_apprentice.py` are manual today; without a cadence the episodes sit cold. Build a sequenced runner the systemd oneshot calls, fail-soft per stage (synthesize fails closed if Ollama is down — that must not abort ingest or apprentice). Model the unit/timer on `linux/systemd/logueos-sentinel.service` + `.timer` (verified convention: `Type=oneshot`, `User=dreighto`, venv python, `EnvironmentFile=.env`).

**Files:** create `tools/run_companion_learning.py`; create `tests/test_run_companion_learning.py`; create `linux/systemd/logueos-companion-learning.service`; create `linux/systemd/logueos-companion-learning.timer`

- [ ] Write the failing test. Create `tests/test_run_companion_learning.py`:

```python
"""Sequenced companion-learning cadence runner (spec §4.10 Part A.5)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "tools" / "run_companion_learning.py"


def _import_module():
    spec = importlib.util.spec_from_file_location("run_companion_learning_under_test", str(MODULE_PATH))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["run_companion_learning_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_runs_three_stages_in_order():
    mod = _import_module()
    calls: list[str] = []
    result = mod.run_pipeline(
        ingest=lambda: calls.append("ingest"),
        synthesize=lambda: calls.append("synthesize"),
        apprentice=lambda: calls.append("apprentice"),
    )
    assert calls == ["ingest", "synthesize", "apprentice"]
    assert result["ingest"] == "ok"
    assert result["synthesize"] == "ok"
    assert result["apprentice"] == "ok"


def test_synthesize_failure_does_not_abort_apprentice():
    mod = _import_module()
    calls: list[str] = []

    def boom():
        raise RuntimeError("Ollama unreachable")

    result = mod.run_pipeline(
        ingest=lambda: calls.append("ingest"),
        synthesize=boom,
        apprentice=lambda: calls.append("apprentice"),
    )
    assert calls == ["ingest", "apprentice"]
    assert result["synthesize"].startswith("error:")
    assert result["apprentice"] == "ok"
```

- [ ] Run it (expect FAIL — module does not exist):

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && python -m pytest tests/test_run_companion_learning.py -q
```

Expected: FAIL, `ModuleNotFoundError` / `spec.loader.exec_module` raises `FileNotFoundError`.

- [ ] Minimal implementation. Create `tools/run_companion_learning.py`:

```python
"""run_companion_learning.py — cadence runner for the Sully learning pipeline.

Sequences the three MANUAL tools (spec §4.10 Part A.5) so episodes don't sit
cold: ingest_memory (JSONL -> observations table), synthesize_lessons
(observations -> provisional_lessons; fails closed if Ollama is down), and
hermes_apprentice (routing_history + sully_episodes -> learning cases).

Fail-soft per stage: a synthesize failure (Ollama down) must NOT abort ingest
or apprentice. Each stage's outcome is recorded. Invoked by the systemd
oneshot logueos-companion-learning.service on an hourly timer.

Usage:
    python tools/run_companion_learning.py
"""

from __future__ import annotations

import sys
from typing import Callable


def _stage(fn: Callable[[], None]) -> str:
    try:
        fn()
        return "ok"
    except Exception as exc:  # fail-soft: record, never abort the pipeline
        return f"error: {exc}"


def run_pipeline(
    ingest: Callable[[], None],
    synthesize: Callable[[], None],
    apprentice: Callable[[], None],
) -> dict[str, str]:
    """Run the three stages in order, fail-soft. Returns per-stage status."""
    return {
        "ingest": _stage(ingest),
        "synthesize": _stage(synthesize),
        "apprentice": _stage(apprentice),
    }


def _default_stages() -> tuple[Callable, Callable, Callable]:
    """Wire the real tools. Imported lazily so the test can inject fakes."""
    import os

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import hermes_apprentice
    import ingest_memory
    import synthesize_lessons

    def _ingest() -> None:
        ingest_memory.ingest()

    def _synthesize() -> None:
        clusterer = synthesize_lessons.build_clusterer()
        import sqlite3

        conn = sqlite3.connect(synthesize_lessons.DB_PATH)
        try:
            synthesize_lessons.synthesize(conn, clusterer)
        finally:
            conn.close()

    def _apprentice() -> None:
        hermes_apprentice.run(
            routing_history_path=hermes_apprentice._default_path("routing_history.jsonl"),
            callbacks_path=hermes_apprentice._default_path("pending_callbacks.jsonl"),
            output_path=hermes_apprentice._default_path("hermes_learning_cases.jsonl"),
            sully_episodes_path=hermes_apprentice._default_path("sully_episodes.jsonl"),
        )

    return _ingest, _synthesize, _apprentice


def main() -> int:
    ingest, synthesize, apprentice = _default_stages()
    result = run_pipeline(ingest, synthesize, apprentice)
    print(f"[run_companion_learning] {result}", file=sys.stderr)
    # Exit 0 even on per-stage failure — fail-soft cadence; the journal carries
    # the per-stage status for the operator to inspect.
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] Run it (expect PASS):

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && python -m pytest tests/test_run_companion_learning.py -q
```

Expected: PASS, both sequencing + fail-soft tests green.

- [ ] Create the systemd service `linux/systemd/logueos-companion-learning.service`:

```ini
[Unit]
Description=LogueOS Companion Learning cadence — ingest -> synthesize -> apprentice
Documentation=https://github.com/Dreighto/LogueOS-Orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=dreighto
WorkingDirectory=/home/dreighto/dev/LogueOS-Orchestrator
EnvironmentFile=/home/dreighto/dev/LogueOS-Orchestrator/.env
ExecStart=/home/dreighto/dev/LogueOS-Orchestrator/.venv/bin/python3 tools/run_companion_learning.py
Environment=PYTHONUNBUFFERED=1
StandardOutput=journal
StandardError=journal
```

- [ ] Create the systemd timer `linux/systemd/logueos-companion-learning.timer`:

```ini
[Unit]
Description=Run LogueOS Companion Learning cadence hourly
Requires=logueos-companion-learning.service

[Timer]
# Start 10 min after boot to let Ollama settle, then hourly.
OnBootSec=10min
OnUnitActiveSec=1h
Unit=logueos-companion-learning.service
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] Verify the unit files parse (no install required for the plan; install is an operator action):

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && systemd-analyze verify linux/systemd/logueos-companion-learning.service linux/systemd/logueos-companion-learning.timer 2>&1 | head
```

Expected: no output (or only benign "Unit is bound to inactive unit" notices — the service is a oneshot, which is correct). A hard parse error here means a typo in the unit.

- [ ] Commit:

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && git add tools/run_companion_learning.py tests/test_run_companion_learning.py linux/systemd/logueos-companion-learning.service linux/systemd/logueos-companion-learning.timer && git commit -m "feat(cadence): sequenced companion-learning runner + hourly systemd timer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task B6 — Local RAG decision store (STANDALONE NOW; runtime wiring GATED on Phase-1)

Spec §4.10 Part B.1 + §8: log every decision (query + route + rationale + approve/override) to a local vector store; at decision time retrieve k=4-8 nearest past decisions as dynamic few-shot. Use sqlite-vec (vec0 virtual table) in a NEW `sully_rag.db` (NOT companion.db — keeps the vector index isolated and droppable). Embeddings via `mxbai-embed-large:latest` over Ollama (CPU-resident per §8 — the embedder must never swap the GPU). The embedder is injected so the test can stub it (no live Ollama dependency in CI).

`mxbai-embed-large` emits 1024-dim float vectors. The vec0 table is declared `float[1024]`.

**Files:** create `src/lib/server/sully_rag_store.ts`; create `tests/sully-rag-store.test.ts`; modify `package.json`

- [ ] Add the dependency:

```bash
cd /home/dreighto/dev/LogueOS-Companion && npm install sqlite-vec
```

Expected: `sqlite-vec` added to `package.json` dependencies.

- [ ] Write the failing test. Create `tests/sully-rag-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SullyRagStore } from '$lib/server/sully_rag_store';

let dbPath: string;

// Deterministic stub embedder: maps a string to a fixed-dim vector by char code
// buckets. Same text → same vector; "escalate this build" and "build escalation"
// land closer than an unrelated phrase.
function stubEmbed(text: string): number[] {
	const v = new Array(1024).fill(0);
	for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % 1024] += 1;
	return v;
}

beforeEach(() => {
	dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sully-rag-')), 'sully_rag.db');
});
afterEach(() => {
	fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

describe('SullyRagStore', () => {
	it('logs a decision and retrieves it as a nearest neighbour', async () => {
		const store = new SullyRagStore(dbPath, stubEmbed);
		await store.logDecision({
			traceId: 'tr-1',
			query: 'escalate this build to claude-code',
			route: 'escalate',
			rationale: 'repo signal present',
			reward: 1
		});
		const hits = await store.retrieve('escalate this build to claude-code', 4);
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(hits[0].trace_id).toBe('tr-1');
		expect(hits[0].route).toBe('escalate');
		store.close();
	});

	it('ranks the closer decision first', async () => {
		const store = new SullyRagStore(dbPath, stubEmbed);
		await store.logDecision({
			traceId: 'near',
			query: 'fix the failing build',
			route: 'escalate',
			rationale: 'r',
			reward: 1
		});
		await store.logDecision({
			traceId: 'far',
			query: 'what is the weather today',
			route: 'handle-locally',
			rationale: 'r',
			reward: 0
		});
		const hits = await store.retrieve('fix the failing build now', 2);
		expect(hits[0].trace_id).toBe('near');
		store.close();
	});

	it('returns empty when the store has no rows', async () => {
		const store = new SullyRagStore(dbPath, stubEmbed);
		const hits = await store.retrieve('anything', 4);
		expect(hits).toEqual([]);
		store.close();
	});
});
```

- [ ] Run it (expect FAIL — module does not exist):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/sully-rag-store.test.ts
```

Expected: FAIL, `Failed to resolve import "$lib/server/sully_rag_store"`.

- [ ] Minimal implementation. Create `src/lib/server/sully_rag_store.ts`:

```ts
// Sully RAG decision store (spec §4.10 Part B.1). Logs every routing decision
// to a local sqlite-vec vector index and retrieves the k nearest past
// decisions as dynamic few-shot at decision time. Isolated in its own
// sully_rag.db (NOT companion.db) so the index can be rebuilt/dropped freely.
//
// Embeddings: mxbai-embed-large (1024-dim), CPU-resident over Ollama (§8 — the
// embedder must NEVER swap the GPU). The embedder fn is injected so it can be
// stubbed in tests and pointed at Ollama in production via embedWithOllama().

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const EMBED_DIM = 1024;

export type Embedder = (text: string) => number[] | Promise<number[]>;

export interface DecisionInput {
	traceId: string;
	query: string;
	route: 'escalate' | 'handle-locally';
	rationale: string;
	reward: number; // 1 = approve, 0 = override/skip
}

export interface RetrievedDecision {
	trace_id: string;
	query: string;
	route: string;
	rationale: string;
	reward: number;
	distance: number;
}

/** Production embedder: mxbai-embed-large over a CPU-resident Ollama. */
export async function embedWithOllama(text: string): Promise<number[]> {
	const base = process.env.OLLAMA_BASE_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:11434';
	const res = await fetch(`${base}/api/embeddings`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: 'mxbai-embed-large', prompt: text })
	});
	if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
	const data = (await res.json()) as { embedding?: number[] };
	if (!Array.isArray(data.embedding)) throw new Error('embed: no embedding in response');
	return data.embedding;
}

export class SullyRagStore {
	private db: Database.Database;
	private embed: Embedder;

	constructor(dbPath: string, embed: Embedder = embedWithOllama) {
		this.db = new Database(dbPath);
		sqliteVec.load(this.db);
		this.embed = embed;
		this.db.pragma('journal_mode = WAL');
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sully_decisions (
				rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
				trace_id    TEXT,
				query       TEXT NOT NULL,
				route       TEXT NOT NULL,
				rationale   TEXT,
				reward      INTEGER NOT NULL DEFAULT 0,
				created_at  TEXT NOT NULL
			);
		`);
		this.db.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS vec_decisions USING vec0(embedding float[${EMBED_DIM}]);`
		);
	}

	async logDecision(input: DecisionInput): Promise<void> {
		const vec = await this.embed(input.query);
		const info = this.db
			.prepare(
				`INSERT INTO sully_decisions (trace_id, query, route, rationale, reward, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(
				input.traceId,
				input.query,
				input.route,
				input.rationale,
				input.reward,
				new Date().toISOString()
			);
		this.db
			.prepare(`INSERT INTO vec_decisions (rowid, embedding) VALUES (?, ?)`)
			.run(info.lastInsertRowid, new Float32Array(vec).buffer);
	}

	async retrieve(query: string, k = 6): Promise<RetrievedDecision[]> {
		const count = (
			this.db.prepare(`SELECT COUNT(*) AS n FROM sully_decisions`).get() as { n: number }
		).n;
		if (count === 0) return [];
		const vec = await this.embed(query);
		const rows = this.db
			.prepare(
				`SELECT d.trace_id, d.query, d.route, d.rationale, d.reward, v.distance
				 FROM vec_decisions v
				 JOIN sully_decisions d ON d.rowid = v.rowid
				 WHERE v.embedding MATCH ? AND k = ?
				 ORDER BY v.distance ASC`
			)
			.all(new Float32Array(vec).buffer, k) as RetrievedDecision[];
		return rows;
	}

	close(): void {
		this.db.close();
	}
}
```

- [ ] Run it (expect PASS):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/sully-rag-store.test.ts
```

Expected: PASS — log + retrieve, nearest-first ranking, empty-store all green.

- [ ] Commit:

```bash
cd /home/dreighto/dev/LogueOS-Companion && git add package.json package-lock.json src/lib/server/sully_rag_store.ts tests/sully-rag-store.test.ts && git commit -m "feat(companion): sqlite-vec RAG decision store + mxbai-embed-large CPU embedder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> **Runtime-wiring note (GATED on Phase-1):** calling `logDecision` on episode close and `retrieve` at decision time lands in the Phase-1 decision-gate plan, behind `runMode.learningEnabled`, using `embedWithOllama`. This task delivers the store + injectable embedder.

---

### Task B7 — LinUCB contextual-bandit router (STANDALONE NOW)

Spec §4.10 Part B.2: contextual bandit (LinUCB), ~50-100 LOC, arms = `{handle-locally, escalate}`, reward approve(+1)/override(0), recency decay. LinUCB maintains per-arm `A` (d×d) and `b` (d×1); the chosen arm maximizes `θ·x + α·sqrt(xᵀA⁻¹x)`. Recency decay multiplies `A` and `b` by a decay factor on each update so old evidence fades. Pure TypeScript, no deps, <50 MB. Context vector `x` is small (the spec's decision features), keeping `A⁻¹` cheap.

**Files:** create `src/lib/server/sully_bandit.ts`; create `tests/sully-bandit.test.ts`

- [ ] Write the failing test. Create `tests/sully-bandit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LinUCBBandit } from '$lib/server/sully_bandit';

// Context features: [bias, hasRepoSignal, length>floor]
const CTX_ESCALATE = [1, 1, 1];
const CTX_LOCAL = [1, 0, 0];

describe('LinUCBBandit', () => {
	it('exposes the two arms', () => {
		const b = new LinUCBBandit(3);
		expect(b.arms).toEqual(['handle-locally', 'escalate']);
	});

	it('prefers escalate after repeated approve rewards for escalate context', () => {
		const b = new LinUCBBandit(3, { alpha: 0.5, decay: 1.0 });
		// Teach: escalate-context + escalate arm gets approved (+1) repeatedly;
		// handle-locally on the same context gets overridden (0).
		for (let i = 0; i < 40; i++) {
			b.update('escalate', CTX_ESCALATE, 1);
			b.update('handle-locally', CTX_ESCALATE, 0);
		}
		expect(b.choose(CTX_ESCALATE)).toBe('escalate');
	});

	it('prefers handle-locally for the local context after local approvals', () => {
		const b = new LinUCBBandit(3, { alpha: 0.5, decay: 1.0 });
		for (let i = 0; i < 40; i++) {
			b.update('handle-locally', CTX_LOCAL, 1);
			b.update('escalate', CTX_LOCAL, 0);
		}
		expect(b.choose(CTX_LOCAL)).toBe('handle-locally');
	});

	it('recency decay lets a reversed reward stream flip the preference', () => {
		const b = new LinUCBBandit(3, { alpha: 0.3, decay: 0.9 });
		for (let i = 0; i < 20; i++) b.update('escalate', CTX_ESCALATE, 1);
		// Now the operator starts overriding escalate and approving local.
		for (let i = 0; i < 40; i++) {
			b.update('escalate', CTX_ESCALATE, 0);
			b.update('handle-locally', CTX_ESCALATE, 1);
		}
		expect(b.choose(CTX_ESCALATE)).toBe('handle-locally');
	});

	it('serializes and restores state', () => {
		const b = new LinUCBBandit(3, { alpha: 0.5, decay: 1.0 });
		for (let i = 0; i < 10; i++) b.update('escalate', CTX_ESCALATE, 1);
		const json = b.toJSON();
		const restored = LinUCBBandit.fromJSON(json);
		expect(restored.choose(CTX_ESCALATE)).toBe(b.choose(CTX_ESCALATE));
	});
});
```

- [ ] Run it (expect FAIL — module does not exist):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/sully-bandit.test.ts
```

Expected: FAIL, `Failed to resolve import "$lib/server/sully_bandit"`.

- [ ] Minimal implementation. Create `src/lib/server/sully_bandit.ts`:

```ts
// LinUCB contextual-bandit router for Sully (spec §4.10 Part B.2).
// Arms: handle-locally vs escalate. Reward: approve(+1) / override(0).
// Recency decay fades old evidence so the operator's recent corrections win.
//
// LinUCB per arm: A (d×d, init I), b (d×1, init 0). θ = A⁻¹ b.
// score(x) = θ·x + alpha·sqrt(xᵀ A⁻¹ x). choose = argmax score.
// update(arm, x, r): A = decay·A + x xᵀ ; b = decay·b + r·x.
// Small d (the decision feature vector), so the d×d solve is cheap.

export type Arm = 'handle-locally' | 'escalate';

interface ArmState {
	A: number[][]; // d×d
	b: number[]; // d
}

export interface BanditConfig {
	alpha: number; // exploration weight
	decay: number; // recency decay in (0,1]; 1 = no decay
}

const DEFAULTS: BanditConfig = { alpha: 0.5, decay: 0.97 };

function identity(d: number): number[][] {
	return Array.from({ length: d }, (_, i) =>
		Array.from({ length: d }, (_, j) => (i === j ? 1 : 0))
	);
}

function matVec(M: number[][], v: number[]): number[] {
	return M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}

function dot(a: number[], b: number[]): number {
	return a.reduce((s, x, i) => s + x * b[i], 0);
}

// Solve A y = v via Gauss-Jordan (small d). Returns A⁻¹ v.
function solve(A: number[][], v: number[]): number[] {
	const d = v.length;
	const M = A.map((row, i) => [...row, v[i]]);
	for (let col = 0; col < d; col++) {
		let piv = col;
		for (let r = col + 1; r < d; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
		[M[col], M[piv]] = [M[piv], M[col]];
		const div = M[col][col] || 1e-9;
		for (let j = col; j <= d; j++) M[col][j] /= div;
		for (let r = 0; r < d; r++) {
			if (r === col) continue;
			const f = M[r][col];
			for (let j = col; j <= d; j++) M[r][j] -= f * M[col][j];
		}
	}
	return M.map((row) => row[d]);
}

// A⁻¹ x without re-solving twice: solve once for both score terms.
function invTimes(A: number[][], x: number[]): number[] {
	return solve(A, x);
}

export class LinUCBBandit {
	readonly arms: Arm[] = ['handle-locally', 'escalate'];
	private d: number;
	private cfg: BanditConfig;
	private state: Record<Arm, ArmState>;

	constructor(d: number, cfg: Partial<BanditConfig> = {}) {
		this.d = d;
		this.cfg = { ...DEFAULTS, ...cfg };
		this.state = {
			'handle-locally': { A: identity(d), b: new Array(d).fill(0) },
			escalate: { A: identity(d), b: new Array(d).fill(0) }
		};
	}

	private score(arm: Arm, x: number[]): number {
		const { A, b } = this.state[arm];
		const Ainv_b = solve(A, b); // θ
		const Ainv_x = invTimes(A, x);
		const mean = dot(Ainv_b, x);
		const ucb = this.cfg.alpha * Math.sqrt(Math.max(0, dot(x, Ainv_x)));
		return mean + ucb;
	}

	choose(x: number[]): Arm {
		const sLocal = this.score('handle-locally', x);
		const sEsc = this.score('escalate', x);
		return sEsc > sLocal ? 'escalate' : 'handle-locally';
	}

	update(arm: Arm, x: number[], reward: number): void {
		const st = this.state[arm];
		const { decay } = this.cfg;
		for (let i = 0; i < this.d; i++) {
			for (let j = 0; j < this.d; j++) st.A[i][j] = decay * st.A[i][j] + x[i] * x[j];
			st.b[i] = decay * st.b[i] + reward * x[i];
		}
	}

	toJSON(): string {
		return JSON.stringify({ d: this.d, cfg: this.cfg, state: this.state });
	}

	static fromJSON(json: string): LinUCBBandit {
		const parsed = JSON.parse(json) as {
			d: number;
			cfg: BanditConfig;
			state: Record<Arm, ArmState>;
		};
		const b = new LinUCBBandit(parsed.d, parsed.cfg);
		b.state = parsed.state;
		return b;
	}
}
```

- [ ] Run it (expect PASS):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/sully-bandit.test.ts
```

Expected: PASS — arm exposure, escalate/local preference learning, recency-decay flip, and serialize/restore all green.

- [ ] Commit:

```bash
cd /home/dreighto/dev/LogueOS-Companion && git add src/lib/server/sully_bandit.ts tests/sully-bandit.test.ts && git commit -m "feat(companion): LinUCB contextual-bandit router (handle-locally vs escalate)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task B8 — Confidence calibration (STANDALONE NOW)

Spec §4.10 Part B.3: confidence calibration (temperature/Platt on logs, CPU) as the deferral threshold. Implement temperature scaling (single scalar `T` that divides the logit before the sigmoid) fit by minimizing log-loss over logged `(rawConfidence, wasApproved)` pairs via 1-D gradient descent, plus a deferral-threshold selector that maximizes approve/override separation. Pure TypeScript.

**Files:** create `src/lib/server/sully_calibration.ts`; create `tests/sully-calibration.test.ts`

- [ ] Write the failing test. Create `tests/sully-calibration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { calibrate, applyTemperature, chooseThreshold } from '$lib/server/sully_calibration';

describe('applyTemperature', () => {
	it('is monotonic in raw confidence', () => {
		const T = 1.5;
		const a = applyTemperature(0.6, T);
		const b = applyTemperature(0.8, T);
		expect(b).toBeGreaterThan(a);
	});
	it('returns the input when T=1 (identity at calibration neutral)', () => {
		// T=1 maps the logit back through the sigmoid → original probability.
		expect(applyTemperature(0.73, 1)).toBeCloseTo(0.73, 5);
	});
});

describe('calibrate', () => {
	it('fits a temperature that lowers log-loss vs T=1 on overconfident data', () => {
		// Overconfident: high raw confidence but ~half were overridden.
		const samples = [];
		for (let i = 0; i < 50; i++) samples.push({ rawConfidence: 0.95, approved: i % 2 === 0 });
		const { temperature, logLoss, baselineLogLoss } = calibrate(samples);
		expect(temperature).toBeGreaterThan(1); // softens overconfidence
		expect(logLoss).toBeLessThanOrEqual(baselineLogLoss + 1e-9);
	});
});

describe('chooseThreshold', () => {
	it('separates approve from override', () => {
		const samples = [
			{ rawConfidence: 0.9, approved: true },
			{ rawConfidence: 0.85, approved: true },
			{ rawConfidence: 0.3, approved: false },
			{ rawConfidence: 0.2, approved: false }
		];
		const t = chooseThreshold(samples, 1);
		expect(t).toBeGreaterThan(0.3);
		expect(t).toBeLessThan(0.85);
	});
});
```

- [ ] Run it (expect FAIL — module does not exist):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/sully-calibration.test.ts
```

Expected: FAIL, `Failed to resolve import "$lib/server/sully_calibration"`.

- [ ] Minimal implementation. Create `src/lib/server/sully_calibration.ts`:

```ts
// Confidence calibration for Sully's deferral threshold (spec §4.10 Part B.3).
// Temperature scaling: fit a scalar T that divides the logit before the
// sigmoid, minimizing log-loss over logged (rawConfidence, approved) pairs.
// Then pick a deferral threshold that best separates approve from override.
// CPU, no deps. Calibration runs offline on the decision log (the cadence
// owns invocation; this module is pure math).

export interface CalibrationSample {
	rawConfidence: number; // model's self-reported confidence in [0,1]
	approved: boolean; // operator approved (true) or overrode/skipped (false)
}

const EPS = 1e-6;

function clamp01(p: number): number {
	return Math.min(1 - EPS, Math.max(EPS, p));
}

function logit(p: number): number {
	const c = clamp01(p);
	return Math.log(c / (1 - c));
}

function sigmoid(z: number): number {
	return 1 / (1 + Math.exp(-z));
}

/** Calibrated probability = sigmoid(logit(raw) / T). Monotonic in raw for T>0. */
export function applyTemperature(rawConfidence: number, T: number): number {
	return sigmoid(logit(rawConfidence) / T);
}

function logLossOf(samples: CalibrationSample[], T: number): number {
	let loss = 0;
	for (const s of samples) {
		const p = clamp01(applyTemperature(s.rawConfidence, T));
		const y = s.approved ? 1 : 0;
		loss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
	}
	return loss / Math.max(1, samples.length);
}

export interface CalibrationResult {
	temperature: number;
	logLoss: number;
	baselineLogLoss: number; // at T=1
}

/**
 * Fit temperature by 1-D grid + local refinement (robust, deterministic, no
 * gradient instability). Returns the best T and its log-loss vs the T=1 baseline.
 */
export function calibrate(samples: CalibrationSample[]): CalibrationResult {
	const baselineLogLoss = logLossOf(samples, 1);
	if (samples.length === 0) {
		return { temperature: 1, logLoss: baselineLogLoss, baselineLogLoss };
	}
	let bestT = 1;
	let bestLoss = baselineLogLoss;
	// Coarse grid over plausible temperatures, then refine around the best.
	for (let T = 0.25; T <= 5.0; T += 0.05) {
		const loss = logLossOf(samples, T);
		if (loss < bestLoss) {
			bestLoss = loss;
			bestT = T;
		}
	}
	for (let T = Math.max(0.05, bestT - 0.05); T <= bestT + 0.05; T += 0.005) {
		const loss = logLossOf(samples, T);
		if (loss < bestLoss) {
			bestLoss = loss;
			bestT = T;
		}
	}
	return { temperature: bestT, logLoss: bestLoss, baselineLogLoss };
}

/**
 * Choose a deferral threshold on the CALIBRATED probability that maximizes
 * (approved above) + (overridden below) — i.e. accuracy of the keep/defer split.
 */
export function chooseThreshold(samples: CalibrationSample[], temperature: number): number {
	if (samples.length === 0) return 0.5;
	const cal = samples
		.map((s) => ({ p: applyTemperature(s.rawConfidence, temperature), approved: s.approved }))
		.sort((a, b) => a.p - b.p);
	let bestThreshold = 0.5;
	let bestCorrect = -1;
	const candidates = [0, ...cal.map((c) => c.p), 1];
	for (const t of candidates) {
		let correct = 0;
		for (const c of cal) {
			if (c.approved && c.p >= t) correct++;
			else if (!c.approved && c.p < t) correct++;
		}
		if (correct > bestCorrect) {
			bestCorrect = correct;
			bestThreshold = t;
		}
	}
	return bestThreshold;
}
```

- [ ] Run it (expect PASS):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run tests/sully-calibration.test.ts
```

Expected: PASS — monotonicity, T=1 identity, overconfidence softening (T>1, lower log-loss), threshold separation all green.

- [ ] Commit:

```bash
cd /home/dreighto/dev/LogueOS-Companion && git add src/lib/server/sully_calibration.ts tests/sully-calibration.test.ts && git commit -m "feat(companion): temperature-scaling confidence calibration + deferral threshold

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Final integration check (both repos)

- [ ] Run the full companion suite (no regressions):

```bash
cd /home/dreighto/dev/LogueOS-Companion && npx vitest run
```

Expected: PASS, all existing + new companion tests green.

- [ ] Run the touched Orchestrator suites:

```bash
cd /home/dreighto/dev/LogueOS-Orchestrator && python -m pytest tests/test_hermes_apprentice.py tests/test_synthesize_lessons_sully_partition.py tests/test_run_companion_learning.py -q
```

Expected: PASS, all green (proving the additive `load_sully_episodes` left `_classify_signal` / `_actual_worker` and existing apprentice behaviour intact).

- [ ] Confirm both repos end on a clean tree on the feature branch and return to main per operator rule (do NOT push/PR unless the operator asks):

```bash
cd /home/dreighto/dev/LogueOS-Companion && git status --short && cd /home/dreighto/dev/LogueOS-Orchestrator && git status --short
```

Expected: clean working trees on `feat/sully-hermes-learning` in both repos.

---

## Self-Review

**Spec-coverage check (§4.9-4.10, §10 Phase 3, §12 Phase-3 acceptance):**

- §4.10 Part A.1 labeled `routing_history.jsonl` row (W2 shape, `SULLY-<n>` regex-conforming) → Task A2 `buildRoutingHistoryRow` + `writeRoutingHistory`. Row shape grounded against the live sample (`extracted_signals{task_type,surface_keywords,touches_paths,research_signal}`, `ranked_candidates`, `chosen_worker`, `confidence`, `risk`, `operator_override_flag`, `outcome`, `w2_workflow_version`). ✔
- §4.10 Part A.2 `sully_episodes.jsonl` + action map (approve→a, skip→t, correct-to-X→c/u/x/g, generic→o) → Task A1 `mapOperatorReactionToAction` + `writeSullyDecision`. Codes verified against `hermes_apprentice.py:41-56`. ✔
- §4.10 Part A.3 additive `load_sully_episodes()` feeding `decided_map`, zero change to `_classify_signal` → Task A3. The new loader mirrors `load_pending_callbacks`'s decided_map shape; `build_case` is called unmodified. ✔
- §4.10 Part A.4 `emit_observation` (project_id='logueos-companion', source='sully', kinds routing-correction/what-worked/what-didnt-work) via the hash-chained `agent_decisions.jsonl` path → Task A2 `emitSullyObservation` (spawns `emit_observation.py`, the only sanctioned `append_chained` writer) + `observationKindForReaction`. Kinds verified against `OBSERVATION_KINDS` (`emit_observation.py:133-140`). ✔
- §4.10 Part A.5 cadence cron wiring ingest+synthesize+apprentice → Task A4 runner + systemd timer (modeled on the verified sentinel unit convention). ✔
- §4.10 partition guard (source='sully' bucketed/skipped) → Task A5. ✔
- §4.10 Part B.1 RAG store (sqlite-vec, mxbai-embed-large CPU, k-NN) → Task B6. ✔
- §4.10 Part B.2 LinUCB bandit (arms, reward, recency decay, ~50-100 LOC) → Task B7. ✔
- §4.10 Part B.3 confidence calibration (temperature/Platt, deferral threshold) → Task B8. ✔
- §12 Phase-3 acceptance: "a Sully episode produces a labeled routing_history row + sully_episodes decision" (A1+A2 tests), "a manual hermes_apprentice run yields a non-no_decision case" (A3 `test_sully_episode_yields_non_no_decision_case`), "an observation reaches provisional_lessons after the cadence" (A2 emit + A4 runner + A5 guard — the cadence path is exercised end-to-end by the runner test with the synthesize stage; live Ollama promotion is an operator-run verification), "the RAG store returns a past decision and the bandit updates on approve/override" (B6 + B7 tests). ✔
- §4.10 explicit non-goal honored: NO GPU fine-tuning planned. LoRA/QLoRA distillation noted as a FUTURE eval-gated phase only (see Open Risks). ✔
- New companion-native flag, NOT `_wired`: Task A0 adds `learningEnabled = !_wired && companionLearningEnabled`. Verified `observationsEnabled`/`dispatchEnabled` are `_wired` (`config.ts:148-152`) so reusing them would block companion writes — avoided. ✔

**Placeholder scan:** No "TBD", "similar to Task N", "add error handling", or undefined symbols. Every code block is concrete. Action codes, observation kinds, the routing_history field set, the embed dimension (1024 for mxbai-embed-large), and the systemd unit fields are all grounded against read files / verified facts. ✔

**Type-consistency check across tasks:**

- `OperatorReaction` ('approve'|'skip'|'correct') is defined once in A1 and reused by `observationKindForReaction` (A2) and the test imports — consistent. ✔
- Action codes are a single source (`mapOperatorReactionToAction` in A1) consumed by the Python `load_sully_episodes` join (A3) via the on-disk `action` field — the TS writer and Python reader agree on the `{a,t,c,u,x,g,o}` alphabet, which equals `hermes_apprentice.py`'s `_ACTION_TO_WORKER` keys. ✔
- `task_identifier` namespace `SULLY-<n>` matches `_TRACE_ID_TICKET_RE`/`_NN_PATTERN`-style `^[A-Z]+-\d+$` so ticket inference and apprentice keying work; asserted in both A1 and A2 tests. ✔
- RAG store `EMBED_DIM=1024` matches `mxbai-embed-large` output and the vec0 `float[1024]` declaration; the stub embedder in the B6 test also returns length-1024 vectors — consistent. ✔
- `runMode.learningEnabled` (A0) is the single gate referenced by every "runtime wiring GATED" note (A2, B6) — one flag, no drift. ✔
- The `Arm` union ('handle-locally'|'escalate') in B7 matches the RAG `route` union in B6 and the bandit reward semantics (approve=1/override=0) match the RAG `reward` field — consistent reward convention across B6/B7/B8. ✔

**Append-only invariant check:** `routing_history.jsonl` + `sully_episodes.jsonl` writes use raw `fs.appendFileSync` (A1/A2) — no read-modify-write. `agent_decisions.jsonl` is written ONLY via `emit_observation.py`'s `append_chained` (A2 spawns the script, never appends directly). `sully_rag.db` is a NEW sqlite DB (B6), not an append-only JSONL — correct. ✔

Issues found during review and fixed inline before saving: (1) initial draft reused `observationsEnabled` — corrected to a new `learningEnabled` flag in A0. (2) initial draft wrote `agent_decisions.jsonl` directly from TS — corrected to spawn `emit_observation.py` so the hash chain stays valid. (3) ordered A5 (partition guard) before A4 (cadence runner) so the runner calls the guarded synthesize. (4) `ingest_memory.py` does not persist `source`, so A5's guard reads `source` defensively via `PRAGMA table_info` and tolerates its absence.
