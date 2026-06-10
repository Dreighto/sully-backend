// LOS-191 — the ONE worker registry: kernel parity, named-worker extraction,
// and the no-second-snapshot source assertions (values FLOW from the registry;
// no consumer re-declares the worker universe locally).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	WORKER_REGISTRY,
	DISPATCHABLE_WORKER_NAMES,
	DEFAULT_ROUTED_WORKER,
	getWorker,
	isDispatchableWorker,
	workerLabel,
	extractNamedWorker,
	resolveDispatchableWorker
} from '$lib/server/worker-registry';
import { decide } from '$lib/server/routing/decide';
import { ruleGate, validateGate } from '$lib/server/decisionGate';

// ── Kernel parity ────────────────────────────────────────────────────────────
// Snapshot of the kernel dispatch listener's accepted worker set:
//   LogueOS-Orchestrator/services/dispatch_listener/src/allowlist.js
//   = ALLOWLIST_DEF keys + AIDER_WORKERS. Update BOTH there and in the registry
//   when the roster changes; this test is the drift tripwire.
const KERNEL_DISPATCHABLE = ['claude-code', 'gemini', 'agy', 'cdx', 'gmi', 'dpsk', 'ki', 'glm'];

describe('worker registry — kernel parity', () => {
	it('dispatchable set mirrors the kernel allowlist snapshot', () => {
		expect([...DISPATCHABLE_WORKER_NAMES].sort()).toEqual([...KERNEL_DISPATCHABLE].sort());
	});

	it('non-dispatchable roster members exist and carry rejection copy', () => {
		for (const name of ['cur', 'hermes']) {
			const w = getWorker(name);
			if (!w || w.dispatchable) {
				throw new Error(`${name} should be a non-dispatchable roster member`);
			}
			expect(w.rejection.length).toBeGreaterThan(0);
		}
	});

	it('isDispatchableWorker accepts exact dispatch names only (not aliases)', () => {
		expect(isDispatchableWorker('claude-code')).toBe(true);
		expect(isDispatchableWorker('cc')).toBe(false); // alias — must canonicalize first
		expect(isDispatchableWorker('cur')).toBe(false);
		expect(isDispatchableWorker('nonsense')).toBe(false);
	});

	it('DEFAULT_ROUTED_WORKER is a member of the dispatchable set', () => {
		expect(DISPATCHABLE_WORKER_NAMES).toContain(DEFAULT_ROUTED_WORKER);
	});

	it('labels resolve for names and aliases, with a tolerant fallback', () => {
		expect(workerLabel('dpsk')).toBe('DPSK');
		expect(workerLabel('deepseek')).toBe('DPSK');
		expect(workerLabel('claude-code')).toBe('CC');
		expect(workerLabel('cursor')).toBe('CUR');
		expect(workerLabel('mystery-bot')).toBe('MYS');
	});

	// Live drift tripwire — only runs on a machine with the kernel checkout.
	const KERNEL_ALLOWLIST = path.join(
		os.homedir(),
		'dev/LogueOS-Orchestrator/services/dispatch_listener/src/allowlist.js'
	);
	it.skipIf(!fs.existsSync(KERNEL_ALLOWLIST))(
		'live kernel allowlist mentions every dispatchable name',
		() => {
			const src = fs.readFileSync(KERNEL_ALLOWLIST, 'utf8');
			for (const name of DISPATCHABLE_WORKER_NAMES) {
				expect(new RegExp(`\\b${name}\\b`).test(src), `kernel allowlist missing ${name}`).toBe(
					true
				);
			}
		}
	);
});

// ── No second snapshot — values FLOW from the registry ──────────────────────
// The four LOS-191 hardcode sites (+ the other dispatch consumers) must import
// the registry and must not re-declare the old two-name worker union.
const CONSUMERS = [
	'src/lib/server/companionDispatch.ts',
	'src/lib/server/dispatchJobs.ts',
	'src/lib/server/decisionGate.ts',
	'src/lib/server/chat/autonomous_dispatch.ts',
	'src/lib/server/routing/decide.ts',
	'src/lib/server/routing/turn_decision.ts',
	'src/routes/api/chat/dispatch/confirm/+server.ts',
	'src/lib/server/artifactStore.ts'
];
// Built by concatenation so this test file itself never contains the literal.
const UNION_LITERAL = "'claude-code'" + ' | ' + "'gemini'";

function walkSource(dir: string, out: string[]): void {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
			walkSource(p, out);
		} else if (/\.(ts|js|svelte)$/.test(e.name)) {
			out.push(p);
		}
	}
}

describe('worker registry — no second snapshot', () => {
	it('every dispatch consumer imports the registry', () => {
		for (const f of CONSUMERS) {
			const src = fs.readFileSync(f, 'utf8');
			expect(src.includes('worker-registry'), `${f} does not import worker-registry`).toBe(true);
		}
	});

	it('zero two-name worker union literals remain under src/', () => {
		const files: string[] = [];
		walkSource('src', files);
		const offenders = files.filter((f) => fs.readFileSync(f, 'utf8').includes(UNION_LITERAL));
		expect(offenders).toEqual([]);
	});
});

// ── Named-worker extraction ──────────────────────────────────────────────────
describe('named-worker extraction — every roster name', () => {
	for (const w of WORKER_REGISTRY) {
		it(`command form: "Dispatch ${w.name.toUpperCase()} …" names ${w.name}`, () => {
			const m = extractNamedWorker(`Dispatch ${w.name.toUpperCase()} to look at the routing layer`);
			expect(m?.entry.name).toBe(w.name);
			expect(m?.via).toBe('command');
		});
		for (const a of w.aliases) {
			it(`mention form: "@${a} do X" names ${w.name}`, () => {
				const m = extractNamedWorker(`@${a} take a pass at the header`);
				expect(m?.entry.name).toBe(w.name);
				expect(m?.via).toBe('mention');
			});
		}
	}

	it('command phrasing variants all extract', () => {
		expect(extractNamedWorker('send this to gmi please')?.entry.name).toBe('gmi');
		expect(extractNamedWorker('hand it to codex')?.entry.name).toBe('cdx');
		expect(extractNamedWorker('route to agy')?.entry.name).toBe('agy');
		expect(extractNamedWorker('assign dpsk')?.entry.name).toBe('dpsk');
		expect(extractNamedWorker('hand this off to deepseek')?.entry.name).toBe('dpsk');
	});

	it('unnamed work request extracts nothing (falls to routing)', () => {
		expect(extractNamedWorker('fix the failing build in the auth endpoint')).toBeNull();
		expect(extractNamedWorker('what do you think about dinner')).toBeNull();
	});

	it('alias boundaries hold — cur inside "current" never fires', () => {
		expect(extractNamedWorker('the dispatch queue is current')).toBeNull();
		expect(extractNamedWorker('send the current build to staging')).toBeNull();
	});

	it('resolveDispatchableWorker returns null for named non-dispatchables', () => {
		expect(resolveDispatchableWorker('dispatch cur to poke at the UI')).toBeNull();
		expect(resolveDispatchableWorker('dispatch dpsk to poke at the UI')).toBe('dpsk');
	});
});

// ── ruleGate + decide() integration ─────────────────────────────────────────
describe('roster-aware routing decisions', () => {
	it('"Dispatch DPSK …" force-dispatches dpsk — no confirm round-trip', () => {
		const d = decide({ userText: 'Dispatch DPSK to review the routing layer', fromTool: false });
		expect(d.action).toBe('Dispatch');
		expect(d.worker).toBe('dpsk');
	});

	it('every dispatchable roster name force-dispatches via @-mention', () => {
		for (const name of DISPATCHABLE_WORKER_NAMES) {
			const d = decide({ userText: `@${name} run the audit`, fromTool: false });
			expect(d.action, `@${name} should Dispatch`).toBe('Dispatch');
			expect(d.worker).toBe(name);
		}
	});

	it('naming a non-dispatchable member yields a graceful rejection, not a default', () => {
		const d = decide({ userText: 'dispatch cur to restyle the header', fromTool: false });
		expect(d.action).toBe('Talk');
		expect(d.worker).toBeUndefined();
		expect(d.rejection?.name).toBe('cur');
		expect(d.rejection?.copy).toContain('interactive-only');
	});

	it('hermes (shadow) is likewise rejected with its own copy', () => {
		const r = ruleGate('@hermes check the routing');
		expect(r.forced).toBe(false);
		expect(r.rejection?.name).toBe('hermes');
		expect(r.rejection?.copy.length).toBeGreaterThan(0);
	});

	it('unnamed qualifying work falls to the routing default and ASKS', () => {
		const d = decide({ userText: 'fix the failing build in the auth endpoint', fromTool: false });
		expect(d.action).toBe('Ask');
		expect(d.worker).toBe(DEFAULT_ROUTED_WORKER);
	});

	it('injection guard still precedes named extraction (pasted "Dispatch DPSK")', () => {
		const d = decide({ userText: 'Dispatch DPSK to fix the build in the repo', fromTool: true });
		expect(d.action).toBe('Ask'); // never auto-fires from tool content
	});
});

// ── Gate-schema validation flows from the registry ──────────────────────────
describe('validateGate — roster-aware worker field', () => {
	const block = (worker: string) =>
		`{"escalate":true,"worker":"${worker}","confidence":0.8,"category":"code","brief":"fix","est_scope":"small"}`;

	it('accepts every dispatchable roster name', () => {
		for (const name of DISPATCHABLE_WORKER_NAMES) {
			const v = validateGate(block(name));
			expect(v.ok, `worker ${name} should validate`).toBe(true);
			if (v.ok) expect(v.gate.worker).toBe(name);
		}
	});

	it('canonicalizes an alias to the dispatch name ("cc" → claude-code)', () => {
		const v = validateGate(block('cc'));
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.gate.worker).toBe('claude-code');
	});

	it('rejects non-dispatchable and unknown workers', () => {
		for (const bad of ['cur', 'hermes', 'gpt-9']) {
			const v = validateGate(block(bad));
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.error).toBe('invalid-worker');
		}
	});
});
