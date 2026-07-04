// L1 heuristic phase classifier.
// Pure function, sub-10ms. Called before every model dispatch to determine
// conversation tier (chat / planning / deep / local).
//
// Stickiness rule: once a thread escalates to planning or deep, it stays
// there until the operator explicitly resets via the tier override.

export type Tier = 'chat' | 'planning' | 'deep' | 'local';

const DEEP_PHRASES: string[] = [
	'deep dive',
	'comprehensive analysis',
	'exhaustive',
	'in-depth analysis',
	'thorough analysis',
	'elaborate in detail',
	'detailed breakdown',
	'break everything down'
];

const PLANNING_PHRASES: string[] = [
	"let's plan",
	"let's design",
	'lets plan',
	'lets design',
	'architecture',
	'think through',
	'walk me through',
	'what do you think about',
	'compare these',
	'compare the',
	'help me design',
	'help me plan',
	'what are your thoughts on',
	'roadmap',
	'strategy for',
	'how should we',
	'what would you recommend',
	'pros and cons',
	'tradeoffs',
	'trade-offs'
];

export interface ClassifierInput {
	userMessage: string;
	recentMessages: Array<{ sender: string; message: string }>;
	currentTier: Tier;
	operatorOverride: string | null;
}

/**
 * Classify the conversation tier for a given turn.
 * Operator override wins; then stickiness; then heuristics.
 */
export function classifyTier(input: ClassifierInput): Tier {
	const { userMessage, recentMessages, currentTier, operatorOverride } = input;

	// Operator override is absolute.
	if (operatorOverride === 'local') return 'local';
	if (operatorOverride === 'deep') return 'deep';
	if (operatorOverride === 'planning') return 'planning';
	if (operatorOverride === 'chat') return 'chat';

	// Deep is sticky: stays deep until operator de-escalates.
	if (currentTier === 'deep') return 'deep';

	// Planning is sticky: once in planning, can only escalate to deep.
	if (currentTier === 'planning') {
		const lower = userMessage.toLowerCase();
		if (DEEP_PHRASES.some((p) => lower.includes(p))) return 'deep';
		return 'planning';
	}

	return classifyFromChatTier(userMessage, recentMessages);
}

function classifyFromChatTier(
	userMessage: string,
	recentMessages: Array<{ sender: string; message: string }>
): Tier {
	const lower = userMessage.toLowerCase();

	if (DEEP_PHRASES.some((p) => lower.includes(p))) return 'deep';
	if (PLANNING_PHRASES.some((p) => lower.includes(p))) return 'planning';

	// Length signal.
	if (userMessage.length > 280) return 'planning';
	if (/\n\n/.test(userMessage)) return 'planning';

	// Depth signal: last 4 assistant replies each ≥10% longer than previous.
	const assistantReplies = recentMessages
		.filter((m) => m.sender !== 'operator' && m.sender !== 'system')
		.slice(-4);
	if (assistantReplies.length >= 4) {
		const lengths = assistantReplies.map((m) => m.message.length);
		const escalating = lengths.every((len, i) => i === 0 || len >= lengths[i - 1] * 1.1);
		if (escalating) return 'planning';
	}

	return 'chat';
}
