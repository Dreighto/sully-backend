export interface InteractiveAction {
	command: string;
	reason: string;
	status: 'pending' | 'approved' | 'denied';
	stdout?: string;
	stderr?: string;
}

export interface ChatMessage {
	id: number;
	sender: 'operator' | 'cc' | 'agy' | 'local' | 'hermes' | 'system';
	message: string;
	trace_id: string | null;
	ticket_id: string | null;
	interactive_action: InteractiveAction | null;
	status: 'sent' | 'pending_approval' | 'approved' | 'denied';
	timestamp: string;
	thread_id: string;
	// +1 thumbs-up, -1 thumbs-down, null = no operator signal.
	quality_signal: number | null;
	// Stage 2 per-turn idempotency key. Exposed on history so the client can
	// reuse the REAL turn key on regenerate/retry instead of a display id.
	client_turn_id: string | null;
	// WI-7: the assistant turn's reasoning/thinking trace, so the client can
	// rehydrate the "Thought process" disclosure on a thread reload. Null on
	// operator rows and on replies whose model emitted no reasoning.
	reasoning: string | null;
}
