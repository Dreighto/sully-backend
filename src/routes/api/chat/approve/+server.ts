import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import Database from 'better-sqlite3';
import { serverConfig } from '$lib/server/config';
import { updateActionStatus, addChatMessage } from '$lib/server/chat';
import type { InteractiveAction } from '$lib/types/chat';
import { runMode } from '$lib/server/config';

export const POST: RequestHandler = async ({ request }) => {
	// Approvals only exist for dispatched interactive actions (a kernel feature).
	// Companion mode has none — no-op success.
	if (!runMode.dispatchEnabled) return json({ ok: true });
	try {
		const body = await request.json();
		const { message_id, status } = body; // status is 'approved' or 'denied'

		if (!message_id || !status || (status !== 'approved' && status !== 'denied')) {
			return json(
				{ error: 'message_id and valid status (approved/denied) are required.' },
				{ status: 400 }
			);
		}

		// 1. Fetch the command details from the DB before updating so we can emit a clean system message
		const db = new Database(serverConfig.memoryDbPath);
		let command = 'unknown command';
		let sender = 'agent';
		let traceId: string | null = null;
		let ticketId: string | null = null;
		try {
			const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(message_id) as any;
			if (row && row.interactive_action) {
				const actionObj = JSON.parse(row.interactive_action) as InteractiveAction;
				command = actionObj.command;
				sender = row.sender;
				traceId = row.trace_id || null;
				ticketId = row.ticket_id || null;
			}
		} catch (dbErr) {
			console.error('Failed to pre-fetch command details:', dbErr);
		} finally {
			db.close();
		}

		// 2. Perform the database update on the action card
		const success = updateActionStatus(Number.parseInt(message_id, 10), status);

		if (!success) {
			return json(
				{ error: 'Failed to update action status. Message not found or has no action.' },
				{ status: 400 }
			);
		}

		// 3. Insert a clean system feedback message into the chat so the operator sees the decision logged
		const actionVerb = status === 'approved' ? 'APPROVED' : 'DENIED';
		const feedbackMsg = `Operator **${actionVerb}** the command requested by **${sender}**:\n\`\`\`bash\n${command}\n\`\`\``;

		addChatMessage('system', feedbackMsg, traceId, ticketId);

		return json({ success: true, status });
	} catch (e: unknown) {
		console.error('POST /api/chat/approve error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
