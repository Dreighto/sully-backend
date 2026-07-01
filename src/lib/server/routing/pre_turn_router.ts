// pre_turn_router.ts — Hybrid Brain Phase 2A (SUL-134)
//
// Lightweight classifier that decides whether the local model (companion-v1)
// should even be attempted for a given turn, or whether to route straight to
// the cloud specialist (Sonnet via CLI bridge) before any local inference runs.
//
// Design principle: we want high recall on "this needs cloud" so we don't waste
// 3–8 seconds on local-only to get <<<ESCALATE back. False positives (sending
// something to cloud that local could have handled) are cheap; false negatives
// (letting local try and then escalating) cost latency. Tune toward recall.

export type RouterDecision =
	| { path: 'local' }
	| { path: 'cloud'; reason: 'reasoning' | 'coding' | 'knowledge' | 'context' | 'multimodal' };

// Minimum message count before conversation-length routing kicks in.
// Short threads: local is fine. Long threads accumulate context the local model
// struggles to synthesize across.
const LONG_THREAD_THRESHOLD = 20;

// Code block length threshold (chars of code content) that suggests the turn
// needs a strong code model.
const CODE_BLOCK_CHARS = 200;

type CloudReason = 'reasoning' | 'coding' | 'knowledge' | 'context' | 'multimodal';

/** Ordered list of pattern groups. First match wins. */
const CLOUD_PATTERNS: Array<{ re: RegExp; reason: CloudReason }> = [
	// ── Coding: debugging, analysis, refactoring ──────────────────────────
	{
		re: /\b(debug|debugg|why (doesn'?t|won'?t|isn'?t|can'?t)|broken|not working|doesn'?t work|won'?t (compile|run|build)|stack ?trace|exception|traceback)\b/i,
		reason: 'coding'
	},
	{
		re: /\b(refactor|refactoring|optimize this|rewrite this|code review|review (this|my) (code|function|class|method))\b/i,
		reason: 'coding'
	},
	{
		re: /\b(explain (this|the) (code|function|class|algorithm)|how does this (code|function|work))\b/i,
		reason: 'coding'
	},
	// ── Knowledge: live / current world facts ─────────────────────────────
	{
		re: /\b(today|right now|currently|current (price|rate|status|version)|latest (news|update|version|release)|as of (today|2025|2026))\b/i,
		reason: 'knowledge'
	},
	{
		re: /\b(weather|stock price|exchange rate|breaking news|happened (today|yesterday|this week))\b/i,
		reason: 'knowledge'
	},
	// ── Reasoning: multi-step logic, comparison, design ───────────────────
	{
		re: /\b(compare .{0,60} (vs|versus|against|with)|trade.?offs?|pros? and cons?|which (approach|method|pattern|design|architecture|option) (is better|should I|would you))\b/i,
		reason: 'reasoning'
	},
	{
		re: /\b(step by step|walk me through|break (it|this|that) down|explain (in detail|thoroughly|fully)|comprehensive (guide|explanation|overview))\b/i,
		reason: 'reasoning'
	}
];

/** Extract the text content from markdown code blocks and measure total length. */
function codeBlockContentLength(text: string): number {
	const blocks = text.match(/```[\s\S]*?```/g) ?? [];
	return blocks.reduce((acc, b) => {
		// Strip the opening/closing fence lines to get only the code content
		const inner = b.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
		return acc + inner.length;
	}, 0);
}

/**
 * Decides whether a turn should go to the local model or the cloud specialist.
 *
 * @param userText   The operator's latest message text.
 * @param messageCount  Total messages in the thread so far (including this one).
 */
export function preTurnRoute(userText: string, messageCount: number): RouterDecision {
	// Long conversation — local model context window fills up and quality drops.
	if (messageCount >= LONG_THREAD_THRESHOLD) {
		return { path: 'cloud', reason: 'context' };
	}

	// Large code block in the message — likely needs a strong code model to
	// reason about it, even if the question text itself is simple.
	if (codeBlockContentLength(userText) >= CODE_BLOCK_CHARS) {
		return { path: 'cloud', reason: 'coding' };
	}

	// Pattern-match in order — first hit wins.
	for (const { re, reason } of CLOUD_PATTERNS) {
		if (re.test(userText)) {
			return { path: 'cloud', reason };
		}
	}

	return { path: 'local' };
}
