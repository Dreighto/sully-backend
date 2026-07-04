import type { FinishReason } from 'ai';
import { deleteChatMessage } from '$lib/server/chat';
import { expireTaskById } from '$lib/server/dispatchJobs';

export type ReplyIdWriter = {
	write: (
		chunk:
			| { type: 'data-sully-reply-id'; data: { id: number } }
			| { type: 'finish'; finishReason: FinishReason | undefined }
	) => void;
};

export function emitReplyId(writer: ReplyIdWriter, replyId: number | undefined): void {
	if (typeof replyId === 'number' && replyId > 0) {
		writer.write({ type: 'data-sully-reply-id', data: { id: replyId } });
	}
}

export function finishWriter(writer: ReplyIdWriter, finishReason: FinishReason | undefined): void {
	writer.write({ type: 'finish', finishReason });
}

export function finishWithReplyId(
	writer: ReplyIdWriter,
	replyId: number | undefined,
	finishReason: FinishReason | undefined
): void {
	emitReplyId(writer, replyId);
	finishWriter(writer, finishReason);
}

// Orphan rollback (Stage 1). prepareTurnLifecycle persists the operator row +
// mints a 'proposed' Task BEFORE the model runs. When a turn terminates having
// emitted ZERO reply tokens AND written NO assistant row, undo both, scoped to
// this exact turn. Reused turns are never rollback-eligible because the row/task
// pre-existed this request.
export function rollbackOrphanTurn(operatorRowId: number, taskId: string, reused: boolean): void {
	if (reused) return;
	try {
		if (operatorRowId) deleteChatMessage(operatorRowId);
		expireTaskById(taskId);
	} catch (e) {
		console.error('[sdk-stream] orphan rollback failed', e);
	}
}
