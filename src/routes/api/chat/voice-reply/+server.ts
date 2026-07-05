// Voice-turn reply stream — thin orchestrator. Parses, validates, builds a
// shared context, then delegates to the streaming or non-streaming handler.
// Branch behavior lives in $lib/server/chat/voice_reply_*.ts.

import type { RequestHandler } from './$types';
import { getChatMessages } from '$lib/server/chat';
import { resolveVoiceModel } from '$lib/server/model_catalog';
import { VOICE_KEEP_ALIVE } from '$lib/server/voice_runtime';
import { buildVoiceSystemPrompt } from '$lib/server/chat_prompt';
import { prepareTurnLifecycle } from '$lib/server/chat/stream_prepare';
import { applyTurnDecision } from '$lib/server/chat/autonomous_dispatch';
import { needsFullReply } from '$lib/server/routing/turn_decision';
import { handleVoiceReplyStream } from '$lib/server/chat/voice_reply_stream';
import { handleVoiceReplySimple } from '$lib/server/chat/voice_reply_simple';
import type { VoiceReplyContext, VoiceReplyConstants, DispatchProposalMeta } from '$lib/server/chat/voice_reply_types';
import type { TurnDecision } from '$lib/server/routing/turn_decision';

const VOICE_MODEL = resolveVoiceModel();
const HISTORY = 12;

function extractDispatchProposal(decision: TurnDecision): DispatchProposalMeta | null {
	const verbForCategory = (category: string): string => {
		const c = category.toLowerCase();
		if (c.includes('research')) return 'run a research pass on that';
		if (c.includes('audit')) return 'audit it';
		if (c.includes('scaffold') || c.includes('plan')) return 'sketch the scaffolding';
		if (c.includes('refactor')) return 'put together a refactor proposal';
		if (c.includes('test') || c.includes('verify')) return 'check that out';
		return 'take a look at that';
	};
	switch (decision.kind) {
		case 'PROPOSE':
		case 'DISPATCH':
			return {
				agent: decision.worker,
				target_repo: '',
				brief: decision.brief,
				action: verbForCategory(decision.category),
				kind: decision.kind
			};
		case 'CONFIRM_PROPOSAL':
			return {
				agent: decision.proposal.worker,
				target_repo: decision.proposal.targetRepo ?? '',
				brief: decision.proposal.brief,
				action: verbForCategory(decision.proposal.category),
				kind: decision.kind
			};
		default:
			return null;
	}
}

export const POST: RequestHandler = async ({ request }) => {
	let text = '';
	let threadId = 'default';
	try {
		const body = await request.json();
		text = (body.text || '').trim();
		threadId = body.thread || 'default';
	} catch {
		return new Response('invalid json', { status: 400 });
	}
	if (!text) return new Response('empty text', { status: 400 });

	const { taskId, currentTier, targetRepo, shadowDecision, userMessageText } =
		await prepareTurnLifecycle({ text, threadId, source: 'voice' });

	const decision = shadowDecision;
	const dispatchableDecision = !needsFullReply(decision);
	if (dispatchableDecision) {
		await applyTurnDecision(decision, {
			taskId, threadId, targetRepo,
			userText: userMessageText,
			suppressSpokenChatRow: true
		});
	}

	const turnStartedAt = Date.now();

	const recent = getChatMessages(HISTORY, threadId) as Array<{ sender: string; message: string }>;
	const messages = recent
		.filter((m) => m.sender !== 'system')
		.map((m) => ({ role: m.sender === 'operator' ? 'user' : 'assistant', content: m.message }));
	while (messages.length && messages[0].role !== 'user') messages.shift();
	const turns: Array<{ role: string; content: string }> = [];
	for (const m of messages) {
		const last = turns[turns.length - 1];
		if (last && last.role === m.role) last.content += '\n' + m.content;
		else turns.push({ ...m });
	}

	const voiceSystem = await buildVoiceSystemPrompt(threadId, userMessageText);
	const dispatchProposal = extractDispatchProposal(decision);
	const augmentedSystem =
		dispatchableDecision && dispatchProposal
			? voiceSystem +
				`\n\n## Brainstorming mode (operator's project: "${dispatchProposal.brief}")\n\nRespond like a skilled human assistant in a brainstorming conversation — NOT like an AI offering to do work. Five principles drawn from EA training, hospitality (Ritz-Carlton / Danny Meyer), motivational interviewing, and GROW coaching:\n\n1. Engage with what the operator actually said FIRST. React to the substance. Ask a clarifying question if it'd genuinely help. Don't pivot to "want me to do X?" — that closes the brainstorm.\n2. Stay in OPTIONS, not WILL. The operator is still shaping the idea. Don't jump to "I'll set that up" mid-thought.\n3. Anticipation beats offering. Note that ${dispatchProposal.agent} could help with this kind of work — don't ASK if they want it. The acknowledgment is enough.\n4. If you do surface the dispatch possibility, put it at the TAIL of the reply, conditional, brief. Never lead with it.\n5. Hand the floor back.\n\nGood tail-phrases (use sparingly, only when fitting):\n- "I've got ${dispatchProposal.agent} cued if you go that direction."\n- "If it'd help, ${dispatchProposal.agent} could ${dispatchProposal.action} while you keep thinking."\n- "That one ${dispatchProposal.agent} can just take — say the word."\n- "Whenever you're ready, ${dispatchProposal.agent} is one nod from me."\n\nNEVER use any of these (they read as a robot or a servile chatbot):\n- "This looks like a job for ${dispatchProposal.agent}"\n- "Want me to dispatch this?"\n- "Should I have ${dispatchProposal.agent} get on that right now?"\n- "Let me know what you want me to do next."\n- "I can definitely help with that!"\n\nSometimes the best move is just listening — "Hm, keep going" is a complete reply. Don't force a dispatch suggestion every turn.`
			: voiceSystem;
	const chatMessages = [{ role: 'system', content: augmentedSystem }, ...turns];

	const ctx: VoiceReplyContext = {
		text, threadId, taskId, currentTier, targetRepo,
		decision, dispatchableDecision, dispatchProposal,
		chatMessages, turnStartedAt, userMessageText
	};
	const constants: VoiceReplyConstants = { model: VOICE_MODEL, keepAlive: VOICE_KEEP_ALIVE };

	if (process.env.VOICE_REPLY_STREAMING === 'true') {
		return handleVoiceReplyStream(ctx, constants, request);
	}
	return handleVoiceReplySimple(ctx, constants, request);
};
