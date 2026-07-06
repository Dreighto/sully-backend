import type { UIMessage } from 'ai';

// Byte-identical triplicate across sdk_local_reply.ts / sdk_auto_reply.ts /
// sdk_cli_reply.ts before this split (Wave 4, 2026-07-06) — deduped to one
// shared home; no behavior change, all three call sites still get the same
// function.
export function transcriptFrom(modelMessages: UIMessage[]): string {
	return modelMessages
		.map((m) => {
			const role = m.role === 'assistant' ? 'assistant' : 'user';
			const text = (m.parts || [])
				.filter((p) => p.type === 'text')
				.map((p) => (p as { type: 'text'; text: string }).text)
				.join('');
			return text ? `[${role}]: ${text}` : '';
		})
		.filter(Boolean)
		.join('\n\n');
}
