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
}
