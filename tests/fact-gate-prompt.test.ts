import { describe, it, expect, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({
	env: { LOGUEOS_APP_MODE: 'companion', LOGUEOS_MEMORY_DB_PATH: '/tmp/sully-factprompt-test.db' }
}));

describe('fact-discipline clause injection', () => {
	it('text: a world-fact question gets the source-or-confirm clause', async () => {
		const { buildSystemPrompt } = await import('$lib/server/chat_prompt');
		const p = await buildSystemPrompt(
			{ targetRepo: 'companion', currentTier: 'chat', threadId: 'default', allowSensitive: true },
			'what time does the movie start at the downtown theater?'
		);
		expect(p.toLowerCase()).toMatch(/source|according to|couldn.t confirm|can.t confirm/);
	});
	it('text: a casual opinion gets NO fact clause', async () => {
		const { buildSystemPrompt } = await import('$lib/server/chat_prompt');
		const p = await buildSystemPrompt(
			{ targetRepo: 'companion', currentTier: 'chat', threadId: 'default', allowSensitive: true },
			'what do you think about the rabbit icon direction?'
		);
		expect(p).not.toMatch(/According to X|couldn't confirm that|find a reliable source/);
	});
	it('voice: a world-fact question gets the clause too', async () => {
		const { buildVoiceSystemPrompt } = await import('$lib/server/chat_prompt');
		const p = await buildVoiceSystemPrompt('default', 'how much does the new GPU cost right now?');
		expect(p.toLowerCase()).toMatch(/source|according to|couldn.t confirm|can.t confirm/);
	});
});
