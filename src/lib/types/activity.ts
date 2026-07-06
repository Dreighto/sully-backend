export type ActivityEventType =
	| 'worker_spawned'
	| 'worker_exit'
	| 'worktree_cleanup_stashed'
	| 'dispatch_rejected'
	| 'hmac_reject'
	| 'listener_listening'
	| 'listener_restarted';

export interface ActivityEvent {
	id: string; // unique ID for Svelte each block, can be index or combination
	ts: string; // ISO timestamp
	msg: ActivityEventType;
	summary: string;
	level: 'info' | 'success' | 'warning' | 'error';
	trace_id?: string;
	ticket_id?: string;
	worker?: string;
}
