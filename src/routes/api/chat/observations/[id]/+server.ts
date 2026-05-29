import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteChatObservation } from '$lib/server/observation_emit';

/**
 * DELETE /api/chat/observations/[id]
 * Removes a chat-sourced Tier 0 observation before it can be promoted to Tier 1.
 * Only chat_thread-sourced observations may be deleted via this endpoint.
 */
export const DELETE: RequestHandler = async ({ params }) => {
	const { id } = params;
	if (!id) return json({ error: 'missing_id' }, { status: 400 });

	try {
		const result = deleteChatObservation(id);
		if (!result.ok) {
			if (result.reason === 'not_found') {
				return json({ error: 'not_found' }, { status: 404 });
			}
			if (result.reason === 'not_chat_sourced') {
				return json(
					{
						error: 'forbidden',
						message: 'Only chat-sourced observations may be deleted via this endpoint.'
					},
					{ status: 403 }
				);
			}
			return json({ error: result.reason }, { status: 500 });
		}
		return json({ ok: true });
	} catch (e: unknown) {
		console.error('DELETE /api/chat/observations/:id error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};
