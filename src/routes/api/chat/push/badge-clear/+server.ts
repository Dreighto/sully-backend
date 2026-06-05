// Clear the APNs badge count when the operator opens the app or views tasks.
// Called by the Capacitor app on foreground (app resume) and by the task list
// when it becomes visible.
//
// Also sends an APNs push with badge=0 to immediately clear the lock-screen
// badge (APNs requires a push to update the badge number even to zero).
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearBadge } from '$lib/server/push_badge';
import { sendApnsToAll } from '$lib/server/apns';

export const PUT: RequestHandler = async () => {
	try {
		clearBadge();
		// Fire a silent badge-clear push (badge=0, no alert body).
		// APNs content-available=1 + badge=0 clears the icon badge without
		// showing a notification. Self-gated: no-op when APNs isn't configured.
		void sendApnsToAll({
			title: '',
			body: '',
			badge: 0
		}).catch((e) => console.error('[badge-clear] apns error', e));
		return json({ ok: true });
	} catch (e) {
		console.error('PUT /api/chat/push/badge-clear error:', e);
		return json({ error: 'internal_server_error' }, { status: 500 });
	}
};

export const POST: RequestHandler = async (event) => PUT(event);
