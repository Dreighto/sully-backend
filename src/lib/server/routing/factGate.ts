// Fact-Sensitivity Gate (spec Contract 4 / I9). Pure, deterministic, no LLM.
// Runs on conversational (ANSWER_NOW) turns to decide whether the answer needs
// a source/check before being stated as fact. Precision-biased: default to
// 'conversational' (answer free) — only escalate on clear fact signals, so
// casual chat is never slowed or web-searched.

export type FactCategory = 'conversational' | 'world_fact' | 'system_fact';
export interface FactGateResult {
	category: FactCategory;
	sensitive: boolean; // category !== 'conversational'
	reason: string;
}

// System/work-state questions (asking ABOUT state, not asking to CHANGE it —
// work intent is handled upstream by the Intent Gate). Checked FIRST so e.g.
// "is the build passing" goes system, not world.
// NOTE: 'companion', 'console', bare 'process' removed — operator says "companion" constantly
// and "process" fires on casual usage like "did you process that".
const SYSTEM_RE =
	/\b(service|server|daemon|port|disk|cpu|memory|deploy(ed|ment)?|build|ci\b|pipeline|test(s| suite| pass)|prs?\b|pull request|branch|commit|git\b|log(s)?|database|db\b|table|endpoint|uptime|health|systemctl|orchestrator)\b/i;
const SYSTEM_ASK_RE =
	/\b(is|are|did|does|was|were|how many|what('?s| is| does)|status|running|up|down|listening|passing|failed|merged|open)\b/i;

// World/current facts — two tiers:
//   WORLD_STRONG_RE: unambiguously factual phrases — fire directly, no question signal needed.
//   WORLD_WEAK_RE:   ambiguous single tokens that only trigger when the message has a question
//                    signal (trailing '?' OR interrogative lead word). This prevents "today was
//                    rough", "any news on the launch", "do you have time to chat", etc. from
//                    false-triggering.
const WORLD_STRONG_RE =
	/(\bwhat time\b|\bhow much\b|\bprice\b|\bcost\b|\$\d|\bin stock\b|\bavailab(le|ility)\b|\bweather\b|\bforecast\b|\bshowtime\b|\brelease date\b|\bexchange rate\b|\bcurrent price\b|\bcurrent status\b|\bnear ?by\b|\blocation\b|\baddress\b|\bright now\b|\bdoes .{1,40} exist\b|\bwhat.s the latest\b|\bhours of\b)/i;

const WORLD_WEAK_RE =
	/\b(when|today|tonight|this week|news|latest|current(ly)?|open(ing)?|clos(e|ing|ed)|schedule|score|rate|exchange|law|rule|regulation|version|release(d)?)\b/i;

// Question signal: the message ends with '?' OR leads with an interrogative word.
const QUESTION_SIGNAL_RE = /\?$|^\s*(what|when|where|how|is|are|does|do|did|will|who)\b/i;

// Strong conversational markers — opinions/plans/creative/reasoning answer free
// even if a fact keyword brushes past.
const CONVO_RE =
	/\b(think|opinion|feel|prefer|should we|what if|imagine|brainstorm|idea|ideas|design|vibe|approach|how would you|explain|why do|in your view|recommend|suggest)\b/i;

export function factGate(userText: string): FactGateResult {
	const t = (userText || '').trim();
	if (!t) return { category: 'conversational', sensitive: false, reason: 'empty' };

	// Opinion/plan/creative framing wins — never source-check a "what do you think".
	if (
		CONVO_RE.test(t) &&
		!/\b(price|how much|what time|is .* (up|open|running)|current price)\b/i.test(t)
	)
		return { category: 'conversational', sensitive: false, reason: 'conversational marker' };

	if (SYSTEM_RE.test(t) && SYSTEM_ASK_RE.test(t))
		return { category: 'system_fact', sensitive: true, reason: 'system/work state question' };

	if (WORLD_STRONG_RE.test(t) || (WORLD_WEAK_RE.test(t) && QUESTION_SIGNAL_RE.test(t)))
		return { category: 'world_fact', sensitive: true, reason: 'world/current fact' };

	return { category: 'conversational', sensitive: false, reason: 'no fact signal' };
}
