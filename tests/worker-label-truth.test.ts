// LOS-205 — worker label truth.
//
// Operator bug 2026-06-11: dispatching gmi/dpsk/glm from the app showed the
// pill/card labeled CC or AGY. Display-only — pending_jobs.worker carried the
// real kernel ids; WORKER_TEMPLATES was keyed on long names ('gemini',
// 'deepseek', …) so every short-id lookup missed and the fallback dressed the
// worker as Claude Code. A mislabel is a truth-guard violation: an unknown
// worker masquerading as CC.
//
// Locks:
//   1. every kernel allowlist id resolves to its OWN template (table-driven,
//      parity-checked against $lib/server/worker-registry so the sets can't
//      drift apart again);
//   2. long-name aliases land on the same template as their kernel id;
//   3. honest-unknown: an id with no template renders ITSELF, never CC;
//   4. the dpsk-pill-shows-CC regression case.
import { describe, expect, it } from 'vitest';
import {
	WORKER_TEMPLATES,
	resolveWorkerTemplate,
	buildInitialTaskFromProposal
} from '$lib/work-surface/chatBridge.svelte';
import { pillWorker, BRAND_REVEALS } from '$lib/work-surface/pill/pillModel';
import { DISPATCHABLE_WORKER_NAMES } from '$lib/server/worker-registry';
import { workerBrandColor } from '$lib/utils/workerVisual';

// The locked label table — one row per kernel allowlist id (ticket verbatim).
const KERNEL_LABELS: Record<string, { shortCode: string; display: string }> = {
	'claude-code': { shortCode: 'CC', display: 'Claude Code' },
	agy: { shortCode: 'AGY', display: 'Antigravity' },
	cdx: { shortCode: 'CDX', display: 'Codex' },
	gmi: { shortCode: 'GMI', display: 'Gemini' },
	dpsk: { shortCode: 'DPSK', display: 'DeepSeek' },
	glm: { shortCode: 'GLM', display: 'GLM 4.6' },
	ki: { shortCode: 'KI', display: 'Qwen3-Coder' },
	gemini: { shortCode: 'GMI', display: 'Gemini' }
};

describe('every kernel allowlist id resolves to its own template', () => {
	it('the label table covers exactly the dispatchable registry — no drift', () => {
		expect(Object.keys(KERNEL_LABELS).sort()).toEqual([...DISPATCHABLE_WORKER_NAMES].sort());
	});

	for (const [id, expected] of Object.entries(KERNEL_LABELS)) {
		it(`'${id}' → ${expected.shortCode} / ${expected.display}`, () => {
			expect(WORKER_TEMPLATES[id], `'${id}' must be a first-class template key`).toBeTruthy();
			const tpl = resolveWorkerTemplate(id);
			expect(tpl.shortCode).toBe(expected.shortCode);
			expect(tpl.display).toBe(expected.display);
			expect(tpl.identity).toBe(id);
		});
	}

	it('every dispatchable id gets a real brand colour, never neutral chrome', () => {
		for (const id of DISPATCHABLE_WORKER_NAMES) {
			const tpl = resolveWorkerTemplate(id);
			expect(workerBrandColor(tpl.identity, tpl.shortCode), id).not.toBe('var(--ui)');
		}
	});
});

describe('long-name aliases land on the kernel template', () => {
	const ALIAS_CASES: Array<[alias: string, shortCode: string]> = [
		['antigravity', 'AGY'],
		['deepseek', 'DPSK'],
		['codex', 'CDX'],
		['gemini-cli', 'GMI'],
		['claude', 'CC']
	];

	for (const [alias, shortCode] of ALIAS_CASES) {
		it(`'${alias}' → ${shortCode}`, () => {
			expect(resolveWorkerTemplate(alias).shortCode).toBe(shortCode);
		});
	}

	it('resolution is case/whitespace tolerant', () => {
		expect(resolveWorkerTemplate(' DPSK ').shortCode).toBe('DPSK');
		expect(resolveWorkerTemplate('DeepSeek').shortCode).toBe('DPSK');
	});
});

describe('honest-unknown fallback', () => {
	it('renders the raw id — uppercased ≤4-char code + raw display, never CC', () => {
		const tpl = resolveWorkerTemplate('mystery-bot');
		expect(tpl.shortCode).toBe('MYST');
		expect(tpl.display).toBe('mystery-bot');
		expect(tpl.identity).toBe('mystery-bot');
	});

	it('short ids keep their full code', () => {
		expect(resolveWorkerTemplate('x9').shortCode).toBe('X9');
	});

	it("the 'sully' self-handled sentinel renders itself, not CC", () => {
		expect(resolveWorkerTemplate('sully').display).toBe('sully');
	});

	it('unknown ids wear the neutral worker mark, not a brand glyph', () => {
		expect(resolveWorkerTemplate('mystery-bot').icon).toBe('icon-worker');
	});
});

describe('regression: dpsk pill showed CC (operator bug 2026-06-11)', () => {
	it('job row worker id dpsk labels the pill DPSK', () => {
		expect(pillWorker('dpsk', 'sully-anything-123')).toEqual({
			shortCode: 'DPSK',
			display: 'DeepSeek'
		});
	});

	it('gmi / glm / ki job rows label themselves', () => {
		expect(pillWorker('gmi', 'sully-1').shortCode).toBe('GMI');
		expect(pillWorker('glm', 'sully-1').shortCode).toBe('GLM');
		expect(pillWorker('ki', 'sully-1').shortCode).toBe('KI');
	});

	it('trace-id hint gains gmi/glm/ki branches (pre-reconcile only)', () => {
		expect(pillWorker(null, 'sully-gmi-1').shortCode).toBe('GMI');
		expect(pillWorker(null, 'sully-glm-1').shortCode).toBe('GLM');
		expect(pillWorker(null, 'sully-ki-1').shortCode).toBe('KI');
		// tokenized, not substring — 'ki' must not match inside a word
		expect(pillWorker(null, 'sully-kitchen-1').shortCode).toBe('CC');
	});

	it('@dpsk proposal builds a DPSK initial task (chatBridge path)', () => {
		const task = buildInitialTaskFromProposal({
			traceId: 'sully-t1',
			proposalText: 'Want me to dispatch @dpsk for this?'
		});
		expect(task.workers[0].shortCode).toBe('DPSK');
		expect(task.workers[0].display).toBe('DeepSeek');
	});

	it('brand reveals fire for gmi/dpsk off the RESOLVED identity (PR #49/#52 wiring)', () => {
		expect(BRAND_REVEALS[resolveWorkerTemplate('gmi').shortCode]).toBeTruthy();
		expect(BRAND_REVEALS[resolveWorkerTemplate('dpsk').shortCode]).toBeTruthy();
	});
});
