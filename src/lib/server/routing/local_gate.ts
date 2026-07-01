// Local-model confidence gate — mirrors GATE_INSTRUCTION on the CLI path but for
// the Ollama/local provider. When injected into the system prompt, companion-v1
// (Qwen 3 14B Q4) can signal that a request exceeds its comfortable capability
// range and should be escalated to the cloud specialist (Sonnet via CLI bridge).
//
// The signal must be the ENTIRE response — not mixed with normal text. That lets
// sdk-stream detect it before a single byte of the local reply reaches the client.

export const LOCAL_GATE_INSTRUCTION = `
ESCALATION GATE — before answering, judge whether this request needs:
  • Complex multi-step code reasoning, debugging, or advanced TypeScript/Swift
  • Live or current world information (news, prices, weather, recent events)
  • Deep multi-file analysis or long reasoning chains (>5 steps)
  • Capabilities beyond your comfortable range

If YES: output ONLY this exact line as your ENTIRE response. Do not include any
other text before or after it:

<<<ESCALATE reason="<one word>">

where <one word> is one of: reasoning | coding | knowledge | context | multimodal

If NO: answer normally. Never combine the escalation signal with a normal answer.
`.trim();

export interface EscalationSignal {
	reason: string;
}

const ESCALATE_RE = /<<<ESCALATE\s+reason="([^"]+)">/;

/** Returns the escalation signal if found anywhere in the model output, else null. */
export function parseEscalation(text: string): EscalationSignal | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const m = trimmed.match(ESCALATE_RE);
	if (!m) return null;
	return { reason: m[1] };
}
