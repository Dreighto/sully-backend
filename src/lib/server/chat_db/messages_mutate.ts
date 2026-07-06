import fs from 'node:fs';
import { serverConfig } from '../config';
import { getDb } from './messages_read';
import type { InteractiveAction } from '$lib/types/chat';

// Delete a single chat message by id. Used by the regenerate flow to remove
// the old assistant reply before re-streaming a new one. Returns true if a
// row was actually deleted, false otherwise — caller can decide whether a
// missing id is an error.
export function deleteChatMessage(messageId: number): boolean {
	const db = getDb();
	try {
		const info = db.prepare('DELETE FROM chat_messages WHERE id = ?').run(messageId);
		return info.changes > 0;
	} catch (e: unknown) {
		console.error('deleteChatMessage error:', e);
		return false;
	} finally {
		db.close();
	}
}

// The set of `sender` labels a CHAT ASSISTANT reply can carry (CLI/direct/local
// paths persist 'cc' | 'agy' | 'local'; 'companion' covers the companion-mode
// label). Deliberately EXCLUDES 'operator' (the human turn) and 'system' (the
// dispatch ACK / working-bubble rows) so a scoped delete can never touch either.
const CHAT_REPLY_SENDERS = ['agy', 'local', 'cc', 'companion'] as const;

// Stage 3a (replace-reply-on-reuse): delete the PRIOR chat assistant reply row(s)
// for one Task. On a keyed operator-turn REUSE (a retry/regenerate re-POST of the
// same logical turn — same client_turn_id → same reused task_id), the turn produces
// a NEW assistant reply; without this the stale prior reply survives and reappears
// on the next history sync/reopen. Scoped TIGHTLY by (task_id AND sender IN the
// chat-reply set): never removes the operator row, never removes the system/dispatch
// ACK, and — because it keys on the exact reused task_id — never touches a synthesis
// reply belonging to a DIFFERENT turn. On a retry-of-a-failed-send (reused but no
// prior reply exists) it is a harmless no-op (0 rows). Returns the count deleted.
// Guarded against a pre-migration DB (missing column / file) — returns 0.
export function deleteChatRepliesForTask(taskId: string): number {
	if (!taskId) return 0;
	if (!fs.existsSync(serverConfig.memoryDbPath)) return 0;
	const db = getDb();
	try {
		const placeholders = CHAT_REPLY_SENDERS.map(() => '?').join(', ');
		const info = db
			.prepare(
				`DELETE FROM chat_messages
				 WHERE task_id = ? AND sender IN (${placeholders})`
			)
			.run(taskId, ...CHAT_REPLY_SENDERS);
		return info.changes;
	} catch (e: unknown) {
		console.error('deleteChatRepliesForTask error:', e);
		return 0;
	} finally {
		db.close();
	}
}

// Flip a 'pending_approval' proposal message (matched by trace_id) to a
// terminal status so its tap-to-confirm buttons clear. Scoped to
// 'pending_approval' so it can never disturb a normal 'sent' row. Returns the
// row count updated. Used by the ask-before-dispatch confirm endpoint.
export function resolveProposalMessage(traceId: string, status: 'approved' | 'denied'): number {
	const db = getDb();
	try {
		const info = db
			.prepare(
				"UPDATE chat_messages SET status = ? WHERE trace_id = ? AND status = 'pending_approval'"
			)
			.run(status, traceId);
		return info.changes;
	} catch (e: unknown) {
		console.error('resolveProposalMessage error:', e);
		return 0;
	} finally {
		db.close();
	}
}

// Operator's explicit feedback on an assistant reply. `+1` = thumbs-up,
// `-1` = thumbs-down, `null` = clear any prior signal. Returns the row count
// updated (0 = message_id not found). Only persists; the explicit-positive
// fine-tune corpus is harvested out-of-band by scripts/finetune/.
export function setMessageQualitySignal(messageId: number, signal: 1 | -1 | null): boolean {
	const db = getDb();
	try {
		const info = db
			.prepare('UPDATE chat_messages SET quality_signal = ? WHERE id = ?')
			.run(signal, messageId);
		return info.changes > 0;
	} catch (e: unknown) {
		console.error('setMessageQualitySignal error:', e);
		return false;
	} finally {
		db.close();
	}
}

export function updateActionStatus(messageId: number, status: 'approved' | 'denied'): boolean {
	const db = getDb();
	try {
		// First get the existing message
		const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId) as any;
		if (!row) return false;

		let interactive_action: InteractiveAction | null = null;
		if (row.interactive_action) {
			try {
				interactive_action = JSON.parse(row.interactive_action);
			} catch {
				interactive_action = null;
			}
		}

		if (interactive_action) {
			interactive_action.status = status;
			const actionStr = JSON.stringify(interactive_action);

			db.prepare('UPDATE chat_messages SET status = ?, interactive_action = ? WHERE id = ?').run(
				status,
				actionStr,
				messageId
			);
			return true;
		}

		return false;
	} catch (e: unknown) {
		console.error('updateActionStatus error:', e);
		return false;
	} finally {
		db.close();
	}
}
