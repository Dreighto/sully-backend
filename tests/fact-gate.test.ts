import { describe, it, expect } from 'vitest';
import { factGate } from '$lib/server/routing/factGate';

describe('factGate — conversational (answer free)', () => {
	for (const t of [
		'what do you think about a health widget?',
		'should we ship the dashboard first?',
		'I feel like the rabbit icon is the right direction',
		'brainstorm some names for this',
		'how would you approach the layout?',
		'explain how dispatch works'
	])
		it(`conversational: "${t}"`, () => {
			expect(factGate(t).category).toBe('conversational');
			expect(factGate(t).sensitive).toBe(false);
		});
});

describe('factGate — world/current facts (source-check)', () => {
	for (const t of [
		'what time does Dune start at the downtown theater?',
		'how much is the Jetson Orin Nano Super right now?',
		'is the coffee shop on 5th open today?',
		'what is the current price of bitcoin',
		'when does the new season release',
		"what's the latest on the OpenAI news",
		'does a library called bun-sqlite exist'
	])
		it(`world_fact: "${t}"`, () => {
			expect(factGate(t).category).toBe('world_fact');
			expect(factGate(t).sensitive).toBe(true);
		});
});

describe('factGate — system/work facts (deterministic check)', () => {
	for (const t of [
		'is the companion service up right now?',
		'are there any open PRs?',
		'did the last build pass?',
		'what does the git log say happened yesterday',
		'is port 18769 listening'
	])
		it(`system_fact: "${t}"`, () => {
			expect(factGate(t).category).toBe('system_fact');
			expect(factGate(t).sensitive).toBe(true);
		});
});

describe('factGate — precision: casual chat must NOT trigger fact-gate', () => {
	for (const t of [
		'do you have time to chat',
		"let me know when you're free",
		'where should I put this file',
		'where do I start',
		'remember when we shipped that',
		'the companion is so helpful',
		'are you my companion',
		'today was rough',
		"let's do this tonight",
		'any news on the launch',
		"that's a good idea",
		'how are you?'
	])
		it(`conversational (no false positive): "${t}"`, () => {
			expect(factGate(t).category).toBe('conversational');
			expect(factGate(t).sensitive).toBe(false);
		});
});
