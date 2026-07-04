import { getChatMessages } from '$lib/server/chat';
import { runMode } from '$lib/server/config';
import { maybeMarkDeepCandidate } from '$lib/server/observation_emit';
import { persistUserTurn, classifyAndTouchThread, mintTaskId } from '$lib/server/chat_turn';
import { normalizeInputText } from '$lib/server/input_normalizer';
import { detectTargetRepo } from '$lib/server/chat/stream_prepare';
import type { ChatMessage } from '$lib/types/chat';
import type { ThreadState } from '$lib/server/thread_state';
import type { Tier } from '$lib/server/phase_classifier';

export interface LegacyChatBody {
	sender?: string;
	message?: string;
	ticket_id?: string | null;
	agent?: string;
	thread?: string;
	client_turn_id?: string;
	image?: boolean;
	talkback?: boolean;
}

export interface ChatPostContext {
	body: LegacyChatBody;
	sender: string | undefined;
	ticketId: string | null;
	explicitAgent: string;
	threadId: string;
	clientTurnId: string | null;
	imageMode: boolean;
	isTalkback: boolean;
	normalizedMessage: string;
	turnTaskId: string;
	effectiveTaskId: string;
	chatMsg: ChatMessage;
	currentTier: Tier;
	threadState: ThreadState;
	text: string;
	role: string;
	worker: string;
	targetRepo: string;
	isHermes: boolean;
	isAgyChat: boolean;
	hasExplicitDispatchIntent: boolean;
	shouldDispatch: boolean;
	shouldRouteChat: boolean;
	shouldTrigger: boolean;
}

export function buildChatPostContext(body: LegacyChatBody): ChatPostContext | { error: string } {
	const { sender, message, ticket_id } = body;
	// Explicit agent selection from the chat UI's pill switcher. Accepted
	// values: 'auto' | 'claude-code' | 'agy' | 'silent'. When set to anything
	// other than 'auto', it overrides the @-mention heuristic below.
	const explicitAgent: string =
		body && typeof body.agent === 'string' ? body.agent.trim().toLowerCase() : 'auto';
	// Thread scoping. Operators can have multiple parallel chats; each is
	// a separate thread_id. Default thread is 'default'.
	const threadId: string =
		(body && typeof body.thread === 'string' ? body.thread.trim() : '') || 'default';
	// Stage 2: client-supplied per-turn id. When present, a retry/regenerate
	// re-POST of the SAME turn reuses its original operator row + Task instead of
	// minting a duplicate. Absent -> today's behaviour, byte-identical.
	const clientTurnId: string | null =
		body && typeof body.client_turn_id === 'string' && body.client_turn_id.trim()
			? body.client_turn_id.trim()
			: null;
	// Image-generation mode. When true, the operator's message is treated
	// as an image prompt instead of a chat message. Routes to
	// gemini-2.5-flash-image via the Gemini API. Independent of the
	// agent pill - though only AGY (Gemini-class) currently supports it.
	const imageMode: boolean = body && body.image === true;
	// Talkback flag: forces chat tier (Flash-lite) regardless of thread tier
	// per §2D.3 Step C / §2F decision 7. Hard-locked on the server so clients
	// cannot accidentally use a deep-tier model in the high-frequency loop.
	const isTalkback: boolean = body && body.talkback === true;
	const normalizedMessage = normalizeInputText(message || '', isTalkback ? 'walkie' : 'chat');

	if (!normalizedMessage.trim()) {
		return { error: 'Message content is required.' };
	}

	// Mint ONE turn task id before any DB write so the operator row, the task
	// row, and (if a worker fires) the gateway dispatch all share the same handle.
	// Behavior-neutral: proposed rows that never advance are already the Phase-1
	// norm for self-handled turns.
	const turnTaskId = mintTaskId();

	// 1. Persist the operator's turn + classify the conversation tier via
	// the shared chat_turn service (PR C). The legacy route alone needs the
	// returned row + the recent-message count for downstream side-effects.
	const persistedTurn = persistUserTurn({
		text: normalizedMessage,
		threadId,
		sender: sender || 'operator',
		ticketId: ticket_id || null,
		taskId: turnTaskId,
		source: isTalkback ? 'walkie' : 'chat',
		clientTurnId
	});
	const chatMsg = persistedTurn.row;
	// On a keyed reuse the EFFECTIVE task id is the original turn's task_id -
	// use it for classify AND any downstream dispatch so the reused row's Task
	// stays the single handle (a fresh id would orphan them). No key / new turn
	// -> effectiveTaskId === turnTaskId, unchanged.
	const effectiveTaskId = persistedTurn.reused ? (persistedTurn.taskId ?? turnTaskId) : turnTaskId;
	const { currentTier, threadState } = classifyAndTouchThread({
		threadId,
		userText: normalizedMessage,
		taskId: effectiveTaskId
	});
	// PR 8: silently mark Deep-tier threads with 3+ exchanges as observation
	// candidates. Count excludes the just-inserted operator message.
	const recentCount = Math.max(getChatMessages(30, threadId).length - 1, 0);
	maybeMarkDeepCandidate(threadId, currentTier, recentCount);

	// 2. Resolve worker selection. Operator's explicit pill wins if set;
	//    otherwise fall back to @-mention heuristic; otherwise 'auto'.
	const text = normalizedMessage.toLowerCase();
	let role = 'backend';
	let worker = 'auto';
	if (explicitAgent === 'claude-code' || explicitAgent === 'agy') {
		worker = explicitAgent;
	} else if (text.includes('@cc')) {
		worker = 'claude-code';
	} else if (text.includes('@agy') || text.includes('@gemini')) {
		worker = 'agy';
	}
	// Note: the previous bare-substring matching ('claude', 'cc', 'gemini')
	// was removed - it fired on unrelated mentions like "fix the Claude
	// config" or "the cc_completion_log path". Operators that want a
	// specific worker either use @cc / @agy explicitly or pick the pill.

	// Heuristic 2: Repository/Project selection. Use the canonical SDK-stream
	// detector so the legacy route honors the same Sully workspace/artifact rules.
	const targetRepo = detectTargetRepo(normalizedMessage);

	// Dispatch policy (revised 2026-05-26): default to CONVERSATIONAL reply
	// via the LLM router. Worker dispatch fires ONLY when the operator
	// signals explicit intent. Previous default (auto-dispatch every
	// message) was killing planning conversations with system-bubble noise
	// + worker-tone replies. Operator feedback: "it still reads like the
	// system is the one I am talking to when it should be a planning
	// partner... we are engaging in a conversation that will lead to a plan."
	//
	// Explicit dispatch signals:
	//   - explicitAgent === 'claude-code'  (operator picked CC in the pill)
	//   - @cc / @agy / @gemini in the message text (operator named a worker)
	//
	// Implicit conversational signals (default -> llm_router, NO dispatch):
	//   - explicitAgent === 'auto' (default pill, no @-mention)
	//   - explicitAgent === 'agy'  (AGY chat mode - was already routing via llm_router)
	//
	// Workflow buttons (Critique/Build/Verify/Retry) still spawn workers
	// via /api/chat/workflow - that path is intentional and unchanged.
	//
	// Modes that don't fire a remote worker dispatch regardless:
	//   1. explicitAgent === 'silent' - chat note only.
	//   2. explicitAgent === 'hermes' - direct call to local Ollama.
	//   3. imageMode === true        - Gemini image generation.
	//   4. sender === 'system'       - system messages never re-dispatch.
	const isHermes = explicitAgent === 'hermes';
	const isAgyChat = explicitAgent === 'agy';
	const hasExplicitDispatchIntent =
		explicitAgent === 'claude-code' ||
		text.includes('@cc') ||
		text.includes('@agy') ||
		text.includes('@gemini');
	const shouldDispatch =
		hasExplicitDispatchIntent &&
		sender !== 'system' &&
		explicitAgent !== 'silent' &&
		!isHermes &&
		!imageMode;
	// Conversational path: everything that's not a dispatch, not Hermes,
	// not image-gen, not silent. Covers explicit 'agy' pill AND the new
	// default 'auto' chat behavior. Both route through llm_router.
	const shouldRouteChat =
		!shouldDispatch && sender !== 'system' && explicitAgent !== 'silent' && !isHermes && !imageMode;
	// Back-compat alias for the existing dispatch block below.
	const shouldTrigger = shouldDispatch;

	return {
		body,
		sender,
		ticketId: ticket_id || null,
		explicitAgent,
		threadId,
		clientTurnId,
		imageMode,
		isTalkback,
		normalizedMessage,
		turnTaskId,
		effectiveTaskId,
		chatMsg,
		currentTier,
		threadState,
		text,
		role,
		worker,
		targetRepo,
		isHermes,
		isAgyChat,
		hasExplicitDispatchIntent,
		shouldDispatch,
		shouldRouteChat,
		shouldTrigger
	};
}

export interface LegacyHandlerResult {
	routerMeta?: { provider_used: string; model_used: string } | null;
	response?: Response;
}
