// ONE worker registry for the companion's dispatch surface (LOS-191).
//
// Every server module that needs a worker name, label, alias, or dispatchable
// flag imports THIS module — values FLOW from here. Re-declaring the worker
// universe locally (the old two-name claude-code/gemini union, per-file label
// maps) is the LOS-159 snapshot disease: the copy drifts, and "Dispatch DPSK"
// silently becomes claude-code. The parity test (tests/worker-registry.test.ts)
// asserts no consumer carries a local union.
//
// PARITY: the `dispatchable: true` set below MUST mirror the kernel dispatch
// listener's accepted worker set in
//   LogueOS-Orchestrator/services/dispatch_listener/src/allowlist.js
// = ALLOWLIST_DEF keys ('claude-code', 'gemini', 'agy', 'cdx') + AIDER_WORKERS
// ('gmi', 'dpsk', 'ki', 'glm'). When a worker is added or removed there, update
// HERE and the snapshot in the parity test — nothing else.

export interface WorkerEntry {
	/** Dispatch name — the EXACT key the kernel listener's allowlist accepts. */
	name: string;
	/** Operator-facing label ("DPSK is on it"). */
	label: string;
	/**
	 * Lowercase aliases recognized in operator text, for @-mentions and named
	 * dispatch commands. Longest alias wins on overlap (cursor vs cur).
	 */
	aliases: readonly string[];
	/** False → roster member the companion must never auto-dispatch. */
	dispatchable: boolean;
	/** Operator-facing rejection copy for non-dispatchable members. */
	rejection?: string;
	/** One-line role hint, interpolated into the SULLY_GATE teacher instruction. */
	hint?: string;
}

export const WORKER_REGISTRY = [
	{
		name: 'claude-code',
		label: 'CC',
		aliases: ['claude-code', 'claude code', 'claude', 'cc'],
		dispatchable: true,
		hint: 'backend/code generalist'
	},
	{
		name: 'agy',
		label: 'AGY',
		aliases: ['antigravity', 'agy'],
		dispatchable: true,
		hint: 'frontend/build'
	},
	{
		name: 'cdx',
		label: 'CDX',
		aliases: ['codex', 'cdx'],
		dispatchable: true,
		hint: 'implementation/review'
	},
	{
		name: 'gmi',
		label: 'GMI',
		aliases: ['gmi'],
		dispatchable: true,
		hint: 'large-context analysis'
	},
	{
		name: 'dpsk',
		label: 'DPSK',
		aliases: ['deepseek', 'dpsk'],
		dispatchable: true,
		hint: 'reasoning/verification'
	},
	{
		name: 'ki',
		label: 'KI',
		aliases: ['ki'],
		dispatchable: true,
		hint: 'aider-cloud coding'
	},
	{
		name: 'glm',
		label: 'GLM',
		aliases: ['glm'],
		dispatchable: true,
		hint: 'aider-cloud coding'
	},
	{
		// Legacy gemini-cli worker — still allowlisted by the kernel listener.
		// NOT the same as 'gmi' (Gemini via aider) or 'agy' (its replacement);
		// the old companion mapping of @agy → 'gemini' was part of the disease.
		name: 'gemini',
		label: 'Gemini',
		aliases: ['gemini'],
		dispatchable: true,
		hint: 'legacy gemini-cli'
	},
	{
		name: 'cur',
		label: 'CUR',
		aliases: ['cursor', 'cur'],
		dispatchable: false,
		rejection: 'CUR is interactive-only — launch it yourself with `cur`.'
	},
	{
		name: 'hermes',
		label: 'Hermes',
		aliases: ['hermes'],
		dispatchable: false,
		rejection: "Hermes is the shadow routing predictor — it doesn't take dispatch jobs."
	}
] as const satisfies readonly WorkerEntry[];

type Entry = (typeof WORKER_REGISTRY)[number];
/** Any roster member's dispatch name (including non-dispatchable ones). */
export type RosterName = Entry['name'];
/** A worker the companion may actually dispatch — replaces the old hardcoded union. */
export type WorkerName = Extract<Entry, { dispatchable: true }>['name'];

export const DISPATCHABLE_WORKER_NAMES: readonly WorkerName[] = WORKER_REGISTRY.filter(
	(w) => w.dispatchable
).map((w) => w.name as WorkerName);

/**
 * The single sanctioned routing fallback, used ONLY when neither the operator
 * nor the model vote named a worker. Proposals built from it still go through
 * propose/confirm — it never auto-fires. One definition, zero scattered literals.
 */
export const DEFAULT_ROUTED_WORKER: WorkerName = 'claude-code';

const byKey = new Map<string, Entry>();
for (const w of WORKER_REGISTRY) {
	byKey.set(w.name, w);
	for (const a of w.aliases) byKey.set(a, w);
}

/** Look up a roster member by dispatch name OR alias (case-insensitive). */
export function getWorker(nameOrAlias: string): Entry | null {
	return byKey.get(nameOrAlias.trim().toLowerCase()) ?? null;
}

/** Strict: true only for an EXACT dispatchable dispatch name (not an alias). */
export function isDispatchableWorker(name: string): name is WorkerName {
	const entry = getWorker(name);
	return entry?.dispatchable === true && entry.name === name;
}

/** Operator-facing label for any worker id/alias; tolerant of unknown ids. */
export function workerLabel(nameOrAlias: string): string {
	return getWorker(nameOrAlias)?.label ?? nameOrAlias.slice(0, 3).toUpperCase();
}

// ── Named-worker extraction ──────────────────────────────────────────────────
// An explicit worker name in an imperative dispatch command is an operator
// instruction, not a routing suggestion. Two recognized forms:
//   * @-mention:        "@dpsk look at the routing layer"
//   * dispatch command: "Dispatch DPSK …", "send this to gmi", "hand it to codex"
// Plain conversational name-drops ("I talked to claude yesterday") must NOT
// fire — the verb set is deliberately narrow.

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest-first so 'cursor' beats 'cur' and 'claude-code' beats 'claude'.
const ALIAS_ALT = [...byKey.keys()]
	.sort((a, b) => b.length - a.length)
	.map(escapeRe)
	.join('|');
const MENTION_RE = new RegExp(`@(${ALIAS_ALT})\\b`, 'i');
const COMMAND_RE = new RegExp(
	`\\b(?:dispatch|send|hand|route|assign)\\s+(?:(?:this|that|it)\\s+)?(?:(?:off|over)\\s+)?(?:to\\s+)?(${ALIAS_ALT})\\b`,
	'i'
);

export interface NamedWorkerMatch {
	entry: Entry;
	via: 'mention' | 'command';
}

/** The roster member the operator explicitly named this turn, if any. */
export function extractNamedWorker(text: string): NamedWorkerMatch | null {
	const t = (text || '').toLowerCase();
	const mention = t.match(MENTION_RE);
	if (mention) return { entry: byKey.get(mention[1])!, via: 'mention' };
	const command = t.match(COMMAND_RE);
	if (command) return { entry: byKey.get(command[1])!, via: 'command' };
	return null;
}

/** Named DISPATCHABLE worker, or null (named-but-rejected also returns null). */
export function resolveDispatchableWorker(text: string): WorkerName | null {
	const named = extractNamedWorker(text);
	return named && named.entry.dispatchable ? (named.entry.name as WorkerName) : null;
}
