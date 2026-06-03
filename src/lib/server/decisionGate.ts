// Decision Gate (spec §4.2). Three stages, no second local model:
//   1. ruleGate       — zero-token literal pre-filter (@cc/@agy mentions).
//   2. valueGate      — deterministic, model-independent objective-signal gate
//                       + injection guard (tool/pasted content can't auto-fire).
//   3. parseSchema    — validate the {escalate,...} tail of the CLI-bridge reply
//                       (Task 1b.3).

export interface RuleResult {
	forced: boolean;
	worker?: 'claude-code' | 'gemini';
}

// Literal worker mentions force a dispatch route, bypassing the value gate.
export function ruleGate(text: string): RuleResult {
	const t = text.toLowerCase();
	if (t.includes('@cc')) return { forced: true, worker: 'claude-code' };
	if (t.includes('@agy') || t.includes('@gemini')) return { forced: true, worker: 'gemini' };
	return { forced: false };
}

// Objective signals that justify spending a cloud dispatch.
const FILE_PATH_RE = /\b[\w./-]+\.(ts|tsx|js|svelte|py|json|md|css|sql|sh|yaml|yml)\b/;
// Concrete code TARGETS (nouns / situations), NOT verbs. 'refactor' lives in
// IMPERATIVE_RE only — keeping it here too let "refactor X" self-satisfy
// imperative+target with no real target, which is the kind of vague request
// we now want Sully to talk through rather than blind-dispatch.
const CODE_KEYWORD_RE =
	/\b(function|class|import|export|bug|stack ?trace|compile error|build fails?|test fails?|migration|endpoint|component)\b/i;
const REPO_RE = /\b(miru|orchestrator|kernel|console|nasdoom|companion)\b/i;
const IMPERATIVE_RE =
	/\b(fix|add|build|implement|refactor|create|update|remove|migrate|wire|debug|investigate|write)\b/i;

export interface ValueGateResult {
	qualifies: boolean;
	/** True when the content is tool-sourced/pasted — must Ask even in Full-auto. */
	forceAsk: boolean;
	reason: string;
}

/**
 * Deterministic objective-signal gate. TIGHTENED 2026-06-03 after the Task
 * journal caught Sully dispatching CC mid-voice-brainstorm: the operator said
 * "the main focus right now was the companion app... trying to get that wired
 * up" — a bare repo mention ("companion") alone tripped the old gate. Talking
 * ABOUT a project is not asking for work on it.
 *
 * A turn now qualifies ONLY when:
 *   - it names an explicit file path (e.g. src/lib/foo.ts) — strong on its own, OR
 *   - it has an imperative verb (fix/add/build/…) AND a concrete target
 *     (a repo name OR a code keyword).
 *
 * Dropped: the "bare repo / bare code-keyword / long-imperative-alone" paths.
 * A long message that merely mentions a repo, or a long imperative with no
 * concrete target, no longer auto-dispatches. False negatives are cheap (the
 * operator can say "@cc do it"); false positives mid-conversation are the
 * annoying ones we're eliminating. The smarter Phase 2 classifier supersedes
 * this heuristic later.
 */
export function valueGate(input: { text: string; fromTool: boolean }): ValueGateResult {
	const text = (input.text || '').trim();
	const hasFile = FILE_PATH_RE.test(text);
	const hasCode = CODE_KEYWORD_RE.test(text);
	const hasRepo = REPO_RE.test(text);
	const hasImperative = IMPERATIVE_RE.test(text);

	const imperativeWithTarget = hasImperative && (hasRepo || hasCode);
	const qualifies = hasFile || imperativeWithTarget;

	const reason = !qualifies
		? 'no-objective-signal'
		: hasFile
			? 'file-path-signal'
			: hasRepo
				? 'imperative+repo'
				: 'imperative+code';
	// Injection guard: never auto-dispatch tool/pasted content.
	return { qualifies, forceAsk: input.fromTool === true, reason };
}

// ── Stage 3: schema self-assessment (rides the same CLI-bridge Opus reply) ──
// The teacher (cloud Opus via claude_cli_stream.ts) is told to APPEND a single
// machine-readable block as the LAST line of its reply. We strip it from the
// visible text and validate it server-side. Zero extra model, zero extra call.

export const GATE_INSTRUCTION = `
DISPATCH SELF-ASSESSMENT — after your normal reply, if (and only if) the request
would be better executed by a coding worker than answered directly, append ONE
line in EXACTLY this shape as the final line of your message (otherwise omit it):

<<<SULLY_GATE {"escalate":true,"worker":"claude-code","confidence":0.0,"category":"<short>","brief":"<one-line task brief>","est_scope":"small|medium|large"} >>>

worker MUST be "claude-code" (backend/code) or "gemini" (frontend/UI). confidence
is 0..1. Do NOT wrap it in code fences. Emit nothing if no dispatch is warranted.
`.trim();

export interface GateSchema {
	escalate: boolean;
	worker: 'claude-code' | 'gemini';
	confidence: number;
	category: string;
	brief: string;
	est_scope: 'small' | 'medium' | 'large';
}

const GATE_RE = /<<<SULLY_GATE\s*([\s\S]*?)\s*>>>/;

/** Split a raw assembled reply into the operator-visible text + the gate JSON. */
export function extractGateBlock(raw: string): { visible: string; block: string | null } {
	const m = raw.match(GATE_RE);
	if (!m) return { visible: raw.trim(), block: null };
	const visible = raw.replace(GATE_RE, '').trim();
	return { visible, block: m[1].trim() };
}

export type GateValidation = { ok: true; gate: GateSchema } | { ok: false; error: string };

export function validateGate(block: string | null): GateValidation {
	if (!block) return { ok: false, error: 'no-gate-block' };
	let parsed: unknown;
	try {
		parsed = JSON.parse(block);
	} catch {
		return { ok: false, error: 'malformed-json' };
	}
	const g = parsed as Partial<GateSchema>;
	if (typeof g.escalate !== 'boolean') return { ok: false, error: 'escalate-not-boolean' };
	if (g.worker !== 'claude-code' && g.worker !== 'gemini')
		return { ok: false, error: 'invalid-worker' };
	if (typeof g.confidence !== 'number' || g.confidence < 0 || g.confidence > 1)
		return { ok: false, error: 'confidence-out-of-range' };
	if (typeof g.category !== 'string' || !g.category.trim())
		return { ok: false, error: 'missing-category' };
	if (typeof g.brief !== 'string' || !g.brief.trim()) return { ok: false, error: 'missing-brief' };
	if (g.est_scope !== 'small' && g.est_scope !== 'medium' && g.est_scope !== 'large')
		return { ok: false, error: 'invalid-est-scope' };
	return {
		ok: true,
		gate: {
			escalate: g.escalate,
			worker: g.worker,
			confidence: g.confidence,
			category: g.category.trim(),
			brief: g.brief.trim(),
			est_scope: g.est_scope
		}
	};
}
