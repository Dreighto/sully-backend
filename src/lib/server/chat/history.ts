import { getChatMessages } from '$lib/server/chat';
import type { ChatMessage } from '$lib/types/chat';

export interface HistorySinceReset {
	rows: ChatMessage[];
	formattedText: string;
}

function formatHistoryRows(rows: ChatMessage[]): string {
	return rows.map((m) => `[${m.sender} - ${m.timestamp}]: ${m.message}`).join('\n');
}

export function getHistorySinceReset(threadId = 'default', limit = 30): HistorySinceReset {
	const allHistory = getChatMessages(limit, threadId);
	let lastResetIdx = -1;
	for (let i = allHistory.length - 1; i >= 0; i--) {
		if (
			allHistory[i].sender === 'system' &&
			allHistory[i].message.startsWith('--- NEW CONVERSATION ---')
		) {
			lastResetIdx = i;
			break;
		}
	}
	const rows = lastResetIdx >= 0 ? allHistory.slice(lastResetIdx + 1) : allHistory;
	return { rows, formattedText: formatHistoryRows(rows) };
}
