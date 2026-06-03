// Real Sully synthesis (gap-audit Phase 3): when a dispatched worker (CC/AGY)
// finishes, turn its raw result into a short, plain-English summary IN SULLY'S
// VOICE so the Captain (not a coder) can digest it without asking a follow-up.
// Uses Haiku — cheap, robust, no local GPU load (aligns with the voice-VRAM
// offload effort). Best-effort: returns null on any failure/timeout so the
// caller falls back to posting the raw worker result.
import { runConsultClaude } from '../chat/consult';

const SYNTH_MODEL = 'claude-haiku-4-5-20251001';
const SYNTH_TIMEOUT_MS = 20_000;

const SYNTH_SYSTEM = `You are Sully, the Captain's warm, plain-spoken AI companion. A coding worker (CC or AGY) just finished a task you handed off on his behalf. Summarize what came back FOR THE CAPTAIN, who is NOT a coder.

Rules:
- 2–4 sentences, warm and conversational, in plain English. NO jargon, no code, no file paths, no raw logs, no markdown headings or bullet lists.
- Lead with the upshot — what it means for him in human terms — so he can digest it without asking you to explain.
- First person, your own voice ("I had CC check…", "Looks like…").
- If the result is an error or incomplete, say so plainly and suggest the next step.
- Summarize ONLY what's in the worker's output — never invent results you can't see.`;

/**
 * Summarize a finished worker's raw result in Sully's plain-English voice.
 * Returns the summary, or null on empty input / model error / timeout (caller
 * then falls back to the raw result so nothing is lost).
 */
export async function synthesizeWorkerResult(
	args: { brief: string; result: string },
	timeoutMs = SYNTH_TIMEOUT_MS
): Promise<string | null> {
	const result = (args.result || '').trim();
	if (!result) return null;

	const question = `Task you handed off: "${(args.brief || '').trim() || '(no brief recorded)'}".

The worker's raw result:

${result}

Write the plain-English summary for the Captain now.`;

	const gen = runConsultClaude(question, SYNTH_MODEL, SYNTH_SYSTEM)
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
