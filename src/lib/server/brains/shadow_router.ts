// Shadow router (hybrid brain Phase 2) — classifies every message LOCAL vs
// ESCALATE and LOGS the decision WITHOUT acting on it. The SDK still answers
// everything. After a week of real traffic we measure router fidelity against
// what actually happened; nothing switches until the measured agreement gate
// passes (build plan step 2 — the kernel's shadow-loop discipline).
//
// Layering (the R1 lesson encoded — models never stand alone before
// irreversible actions):
//   1. DETERMINISTIC FLOOR: irreversible/high-stakes patterns → ESCALATE,
//      always, regardless of any model's opinion.
//   2. Deterministic fast-paths: greetings/short chitchat → LOCAL.
//   3. Heuristics for the middle; genuinely unsure → 'unsure' (logged; a
//      model tiebreak is Phase 3, behind a flag, and can only move 'unsure').
//
// Corpus: data/router_shadow_corpus.jsonl (same convention as
// system_tool_corpus.jsonl). Best-effort: a shadow write must NEVER break chat.

import fs from 'node:fs';
import path from 'node:path';

export type ShadowDecision = 'LOCAL' | 'ESCALATE' | 'unsure';

export interface ShadowVerdict {
	decision: ShadowDecision;
	/** Which layer decided — floor decisions are non-negotiable by design. */
	source: 'floor' | 'fastpath' | 'heuristic' | 'unsure';
	why: string;
}

// ── 1. The deterministic floor: irreversible / high-stakes / exfil patterns ──
// Kept intentionally broad — a false ESCALATE costs latency; a false LOCAL on
// one of these costs data. Word-boundary matched, case-insensitive.
const FLOOR_PATTERNS: Array<{ re: RegExp; why: string }> = [
	{
		re: /\b(delete|remove|erase|wipe|purge|destroy)\b[\s\S]{0,60}\b(all|every|older|entire|library|photos?|files?|folder|database|account)\b/i,
		why: 'mass/irreversible deletion'
	},
	{
		re: /\b(rm\s+-rf|drop\s+table|force[- ]?push|git\s+reset\s+--hard)\b/i,
		why: 'destructive command'
	},
	{
		re: /\b(send|transfer|pay|wire|purchase|buy|order)\b[\s\S]{0,40}(\$\s?\d|\b(money|payment|dollars?|crypto|bitcoin)\b)/i,
		why: 'money movement'
	},
	{
		re: /\b(deploy|ship|release|publish|go[- ]live|push)\b[\s\S]{0,40}\b(prod|production|live|main|store|app\s?store)\b/i,
		why: 'production deployment'
	},
	{
		re: /\b(email|message|text|post|tweet|send)\b[\s\S]{0,40}\b(everyone|all\s+(contacts|users|friends)|public|blast)\b/i,
		why: 'mass outbound communication'
	},
	{
		re: /\b(password|credential|api\s?key|secret|private\s?key)\b[\s\S]{0,40}\b(send|share|show|paste|post)\b/i,
		why: 'credential exposure'
	}
];

// ── 2. Fast paths: unambiguous everyday traffic ──────────────────────────────
const GREETING_RE =
	/^\s*(hi|hey|hello|yo|sup|morning|good\s?(morning|afternoon|evening|night)|thanks|thank you|ok(ay)?|cool|nice|lol|goodnight)\b[\s!.?,]*$/i;

// ── 3. Heuristics for the middle ─────────────────────────────────────────────
const MULTISTEP_RE =
	/\b(refactor|migrate|rewrite|overhaul|audit|implement|build|debug\s+and\s+fix|across\s+\d+\s+(files|repos|services)|then\s+(deploy|test|verify)|step\s+by\s+step\s+plan)\b/i;
const BIG_CONTEXT_RE = /\b(\d{3,}[- ]?page|entire\s+(codebase|repo|book)|whole\s+project)\b/i;
const SIMPLE_ASK_RE =
	/\b(what|when|where|who|how\s+(much|many|long)|is|are|play|remind|status|weather|time|convert|define)\b/i;

export function classifyShadow(text: string): ShadowVerdict {
	const t = (text || '').trim();
	if (!t) return { decision: 'LOCAL', source: 'fastpath', why: 'empty message' };

	// Floor first — nothing overrides it.
	for (const { re, why } of FLOOR_PATTERNS) {
		if (re.test(t)) return { decision: 'ESCALATE', source: 'floor', why };
	}
	if (GREETING_RE.test(t))
		return { decision: 'LOCAL', source: 'fastpath', why: 'greeting/chitchat' };
	if (MULTISTEP_RE.test(t))
		return { decision: 'ESCALATE', source: 'heuristic', why: 'multi-step agentic shape' };
	if (BIG_CONTEXT_RE.test(t))
		return { decision: 'ESCALATE', source: 'heuristic', why: 'very large context' };
	// Short simple asks lean local; long complex text leans unsure.
	if (t.length <= 160 && SIMPLE_ASK_RE.test(t)) {
		return { decision: 'LOCAL', source: 'heuristic', why: 'short routine ask' };
	}
	if (t.length > 600)
		return { decision: 'unsure', source: 'unsure', why: 'long message, no clear shape' };
	return { decision: 'unsure', source: 'unsure', why: 'no confident heuristic match' };
}

// ── Corpus logging (fire-and-forget, never throws) ──────────────────────────
function corpusPath(): string {
	const root = process.cwd();
	return path.join(root, 'data', 'router_shadow_corpus.jsonl');
}

export interface ShadowLogEntry {
	ts: string;
	thread: string;
	/** First 200 chars only — enough to audit decisions without hoarding text. */
	text_head: string;
	decision: ShadowDecision;
	source: ShadowVerdict['source'];
	why: string;
	/** What the system ACTUALLY did (today: always the SDK path). */
	actual_path: string;
}

export function logShadowDecision(entry: ShadowLogEntry): void {
	try {
		const p = corpusPath();
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.appendFileSync(p, JSON.stringify(entry) + '\n');
	} catch {
		// Best-effort by contract: shadow logging must never break chat.
	}
}

/** One-call convenience used by the chat path. Never throws. */
export function shadowObserve(thread: string, userText: string, actualPath: string): void {
	try {
		const v = classifyShadow(userText);
		logShadowDecision({
			ts: new Date().toISOString(),
			thread,
			text_head: (userText || '').slice(0, 200),
			decision: v.decision,
			source: v.source,
			why: v.why,
			actual_path: actualPath
		});
	} catch {
		/* never break chat */
	}
}

// ── Phase 5: escalation telemetry — apprentice→teacher training loop ──────────
// Every ESCALATE decision is the local model's gap. Logging these lets us
// feed them back into fine-tuning so the local model absorbs what it couldn't
// handle. Fire-and-forget — never blocks the reply.

export interface EscalationLogEntry {
	ts: string;
	thread: string;
	text_head: string;
	reason: string;
	model_used: string;
}

function escalationCorpusPath(): string {
	return path.join(process.cwd(), 'data', 'hybrid_escalation_corpus.jsonl');
}

export function logEscalation(entry: EscalationLogEntry): void {
	try {
		const p = escalationCorpusPath();
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.appendFileSync(p, JSON.stringify(entry) + '\n');
	} catch {
		/* best-effort — never break chat */
	}
}
