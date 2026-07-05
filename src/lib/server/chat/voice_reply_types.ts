import type { Tier } from '$lib/server/phase_classifier';
import type { TurnDecision } from '$lib/server/routing/turn_decision';

export type DispatchProposalMeta = {
	agent: string;
	target_repo: string;
	brief: string;
	action: string;
	kind: TurnDecision['kind'];
};

export interface VoiceReplyContext {
	text: string;
	threadId: string;
	taskId: string | undefined;
	currentTier: Tier;
	targetRepo: string | undefined;
	decision: TurnDecision;
	dispatchableDecision: boolean;
	dispatchProposal: DispatchProposalMeta | null;
	chatMessages: Array<{ role: string; content: string }>;
	turnStartedAt: number;
	userMessageText: string;
}

/** Constants resolved once by the route, passed into handlers. */
export interface VoiceReplyConstants {
	model: string;
	keepAlive: string;
}
