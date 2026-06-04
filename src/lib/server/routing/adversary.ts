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

// The dispatch category is free-form LLM text on the gated/proposal path (the
// teacher emits "backend"/"refactor"/"bugfix"/… not always literally "code"),
// so match a code-ish set, not just "code". The evidence-pointer fallback below
// still catches any state-changing task whatever its label.
const CODE_CATEGORY_RE =
	/\b(code|backend|frontend|refactor|fix|bug|build|test|deploy|migrat|implement|feature|chore)/i;

/** Deterministic stakes gate: review code/file/state-changing work; skip the rest. */
export function shouldReview(job: JobLike, evidence: EvidenceLike): boolean {
	if (job?.category && CODE_CATEGORY_RE.test(job.category)) return true;
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
