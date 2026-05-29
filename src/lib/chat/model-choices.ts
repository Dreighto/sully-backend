import type { ModelChoice } from '$lib/types/chat-ui';

// The chat model-picker catalog. Each entry maps a user-facing choice to the
// (tier, provider) pair the server router pins. 'auto' (null tier + provider)
// means smart tier routing. Server-side, Sonnet/Opus route through the Claude
// Code CLI bridge (Max OAuth); Haiku/Gemini/Local go direct.
export const MODEL_CHOICES: ModelChoice[] = [
	{ id: 'auto', label: 'Auto', sublabel: 'smart tier routing', tier: null, provider: null },
	{
		id: 'claude-haiku',
		label: 'Claude Haiku 4.5',
		sublabel: 'fast · chat tier',
		tier: 'chat',
		provider: 'anthropic'
	},
	{
		id: 'claude-sonnet',
		label: 'Claude Sonnet 4.6',
		sublabel: 'planning',
		tier: 'planning',
		provider: 'anthropic'
	},
	{
		id: 'claude-opus',
		label: 'Claude Opus 4.7',
		sublabel: 'deep',
		tier: 'deep',
		provider: 'anthropic'
	},
	{
		id: 'gemini-flash-lite',
		label: 'Gemini 2.5 Flash-lite',
		sublabel: 'fast · chat tier',
		tier: 'chat',
		provider: 'gemini'
	},
	{
		id: 'gemini-flash',
		label: 'Gemini 2.5 Flash',
		sublabel: 'planning',
		tier: 'planning',
		provider: 'gemini'
	},
	{
		id: 'gemini-pro',
		label: 'Gemini 2.5 Pro',
		sublabel: 'deep',
		tier: 'deep',
		provider: 'gemini'
	},
	{ id: 'local', label: 'Local (Ollama)', sublabel: 'offline', tier: 'local', provider: 'local' }
];
