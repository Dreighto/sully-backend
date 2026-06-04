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
const SYSTEM_RE =
	/\b(service|server|daemon|process|port|disk|cpu|memory|deploy(ed|ment)?|build|ci\b|pipeline|test(s| suite| pass)|prs?\b|pull request|branch|commit|git\b|log(s)?|database|db\b|table|endpoint|uptime|health|systemctl|companion|orchestrator|console)\b/i;
const SYSTEM_ASK_RE =
	/\b(is|are|did|does|was|were|how many|what('?s| is| does)|status|running|up|down|listening|passing|failed|merged|open)\b/i;

// World/current facts — checkable against the world, can change.
const WORLD_RE =
	/\b(time|when|what time|hours?|open(ing)?|clos(e|ing|ed)|schedule|showtime|price|cost|how much|\$|location|address|where|near( ?by)?|available|availability|in stock|weather|forecast|news|latest|current(ly)?|today|tonight|right now|this week|release(d| date)?|score|rate|exchange|law|rule|regulation|version|does .* exist)\b/i;

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

	if (WORLD_RE.test(t))
		return { category: 'world_fact', sensitive: true, reason: 'world/current fact' };

	return { category: 'conversational', sensitive: false, reason: 'no fact signal' };
}
