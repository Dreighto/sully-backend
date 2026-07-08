// Real Sully synthesis (gap-audit Phase 3): when a dispatched worker (CC/AGY)
// finishes, turn its raw result into a short, plain-English summary IN SULLY'S
// VOICE so the Captain (not a coder) can digest it without asking a follow-up.
// Uses Haiku — cheap, robust, no local GPU load (aligns with the voice-VRAM
// offload effort). Best-effort: returns null on any failure/timeout so the
// caller falls back to posting the raw worker result.
import { runConsultClaude } from '../chat/consult';
import { workerLabel } from '../worker-registry';

const SYNTH_MODEL = 'claude-haiku-4-5-20251001';
const SYNTH_TIMEOUT_MS = 20_000;

// The system prompt names the ACTUAL worker that ran — never a hardcoded "CC".
// Sully was contradicting itself: the dispatch-start said "DPSK is on it" but the
// completion summary said "I had CC run that audit" because this prompt baked in
// "CC". Inject the real label so the whole arc is truthful about who did the work.
function synthSystem(who: string): string {
	return `You are Sully, the Captain's warm, plain-spoken AI companion. The worker ${who} just finished a task you handed off on his behalf. Summarize what came back FOR THE CAPTAIN, who is NOT a coder.

Rules:
- 2–4 sentences, warm and conversational, in plain English. NO jargon, no code, no file paths, no raw logs, no markdown headings or bullet lists.
- Lead with the upshot — what it means for him in human terms — so he can digest it without asking you to explain.
- First person, your own voice, and name the ACTUAL worker who ran: "I had ${who} check…", "Looks like…". NEVER credit a different worker than ${who}.
- If ${who} could NOT actually do the task — it asked for files, got the wrong KIND of task, or returned no real findings — say that plainly and name why ("${who} couldn't run that — it only edits code, so a live systems/network check needs CC"). Do NOT dress up a non-result as a result or a vague "no usable results."
- If the result is an error or incomplete, say so plainly and suggest the next step.
- Summarize ONLY what's in the worker's output — never invent results you can't see.`;
}

const POSTURE_FRAMING: Record<'confirmed' | 'hedge' | 'warn', string> = {
	confirmed: '',
	hedge:
		'\n\nIMPORTANT: Some of what the worker reported could NOT be independently verified. Do not state those parts as fact — lead with the uncertainty ("I couldn\'t confirm whether X — the worker said it did, but I have no evidence either way"). Never headline an unverified claim. Never say "it works" — only "everything I could check held up."',
	warn: '\n\nIMPORTANT: A deterministic check CONTRADICTS something the worker claimed. Open with a plain "Heads-up — something doesn\'t line up," name what was contradicted in plain English, and do NOT state the contradicted claim as fact. Recommend the Captain review it.'
};

/**
 * Summarize a finished worker's raw result in Sully's plain-English voice.
 * Returns the summary, or null on empty input / model error / timeout (caller
 * then falls back to the raw result so nothing is lost).
 * The optional `posture` param (from the Go/No-Go poll) drives framing:
 * - confirmed → no extra instruction (default)
 * - hedge     → do-not-state-unverified-claims-as-fact instruction appended
 * - warn      → heads-up-something-contradicted instruction appended
 * The optional `concerns` param (from the adversary reviewer) appends a
 * judgment-framed "reviewer concern" note so the Captain sees it as caution,
 * never as a verified fact.
 */
export async function synthesizeWorkerResult(
	args: {
		brief: string;
		result: string;
		worker?: string | null;
		posture?: 'confirmed' | 'hedge' | 'warn';
		concerns?: string[];
	},
	timeoutMs = SYNTH_TIMEOUT_MS
): Promise<string | null> {
	const result = (args.result || '').trim();
	if (!result) return null;

	const who = args.worker ? workerLabel(args.worker) : 'the worker';
	let system = synthSystem(who) + (POSTURE_FRAMING[args.posture ?? 'confirmed'] || '');
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

	const gen = runConsultClaude(question, SYNTH_MODEL, system)
		.then((r) => ('answer' in r && r.answer ? r.answer.trim() : null))
		.catch(() => null);

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((res) => {
		timer = setTimeout(() => res(null), timeoutMs);
	});
	const out = await Promise.race([gen, timeout]);
	if (timer) clearTimeout(timer);
	return out;
}
