import type { ChatMessage } from '$lib/types/chat';
import { addChatMessage } from '../chat_db/messages_write';
import { buildInteractiveAction } from './action_risk';

/** Insert a pending operator command-approval row with advisory risk on the action payload. */
export function postCommandApprovalMessage(opts: {
	sender: string;
	message: string;
	command: string;
	reason: string;
	traceId?: string | null;
	ticketId?: string | null;
	threadId?: string;
}): ChatMessage {
	const interactiveAction = buildInteractiveAction(opts.command, opts.reason);
	return addChatMessage(
		opts.sender,
		opts.message,
		opts.traceId ?? null,
		opts.ticketId ?? null,
		interactiveAction,
		'pending_approval',
		opts.threadId ?? 'default'
	);
}
