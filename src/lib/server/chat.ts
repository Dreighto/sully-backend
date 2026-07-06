// Wave 3 split (2026-07-06): this file used to hold every chat_messages /
// chat_user_state concern directly (729 lines). It's now a re-export barrel
// over src/lib/server/chat_db/{messages_read,thread_active_state,
// thread_list_search,messages_write,messages_mutate}.ts — kept here because
// addChatMessage alone has ~30 positional callers across the codebase and
// this keeps every external import path unchanged.
export {
	getChatMessages,
	getChatMessagesSince,
	getChatMessageCount,
	getMessagesBeforeRecent,
	type ChatThreadDelta
} from './chat_db/messages_read';
export {
	getActiveThread,
	setActiveThread,
	getLastActiveThread,
	threadExists,
	resolveInitialThread
} from './chat_db/thread_active_state';
export {
	listChatThreads,
	searchChatMessages,
	type SearchResult
} from './chat_db/thread_list_search';
export {
	addChatMessage,
	getOperatorTurnByClientId,
	insertOperatorTurnKeyed,
	type MessageForensics
} from './chat_db/messages_write';
export {
	deleteChatMessage,
	deleteChatRepliesForTask,
	resolveProposalMessage,
	setMessageQualitySignal,
	updateActionStatus
} from './chat_db/messages_mutate';
