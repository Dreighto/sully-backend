import { describe, it, expect } from 'vitest';
import { preTurnRoute } from '../src/lib/server/routing/pre_turn_router';

describe('preTurnRoute — local vs cloud', () => {
	// ── Local (should stay local) ──────────────────────────────────────────
	it('routes casual chat to local', () => {
		expect(preTurnRoute('hey, how are you?', 2)).toEqual({ path: 'local' });
	});

	it('routes short factual question to local', () => {
		expect(preTurnRoute('what is the capital of France?', 1)).toEqual({ path: 'local' });
	});

	it('routes creative writing to local', () => {
		expect(preTurnRoute('write me a haiku about autumn', 3)).toEqual({ path: 'local' });
	});

	// ── Coding ────────────────────────────────────────────────────────────
	it('routes debug question to cloud', () => {
		const d = preTurnRoute("why doesn't this function return the right value?", 2);
		expect(d).toEqual({ path: 'cloud', reason: 'coding' });
	});

	it('routes "not working" to cloud', () => {
		const d = preTurnRoute('my auth middleware is not working after the refactor', 4);
		expect(d).toEqual({ path: 'cloud', reason: 'coding' });
	});

	it('routes stack trace mention to cloud', () => {
		const d = preTurnRoute('i got a stack trace in the console', 3);
		expect(d).toEqual({ path: 'cloud', reason: 'coding' });
	});

	it('routes code review request to cloud', () => {
		const d = preTurnRoute('can you review this code?', 5);
		expect(d).toEqual({ path: 'cloud', reason: 'coding' });
	});

	it('routes refactor request to cloud', () => {
		const d = preTurnRoute('help me refactor this into a class', 2);
		expect(d).toEqual({ path: 'cloud', reason: 'coding' });
	});

	it('routes "explain this code" to cloud', () => {
		const d = preTurnRoute('explain this code to me', 1);
		expect(d).toEqual({ path: 'cloud', reason: 'coding' });
	});

	it('routes message with long code block to cloud', () => {
		// 200+ chars of code content
		const code = 'function foo() {\n' + '  const x = 1;\n'.repeat(15) + '}';
		const d = preTurnRoute(`here is my code:\n\`\`\`ts\n${code}\n\`\`\`\nwhat does it do?`, 2);
		expect(d).toEqual({ path: 'cloud', reason: 'coding' });
	});

	it('routes message with short code block to local (below threshold)', () => {
		const d = preTurnRoute('is this right? `const x = 1`', 2);
		expect(d).toEqual({ path: 'local' });
	});

	// ── Knowledge ─────────────────────────────────────────────────────────
	it('routes "today" question to cloud', () => {
		const d = preTurnRoute("what's the weather today?", 2);
		expect(d).toEqual({ path: 'cloud', reason: 'knowledge' });
	});

	it('routes "latest version" to cloud', () => {
		const d = preTurnRoute('what is the latest version of Node.js?', 1);
		expect(d).toEqual({ path: 'cloud', reason: 'knowledge' });
	});

	it('routes "current price" to cloud', () => {
		const d = preTurnRoute('what is the current price of ETH?', 3);
		expect(d).toEqual({ path: 'cloud', reason: 'knowledge' });
	});

	it('routes breaking news to cloud', () => {
		const d = preTurnRoute('any breaking news today?', 2);
		expect(d).toEqual({ path: 'cloud', reason: 'knowledge' });
	});

	// ── Reasoning ─────────────────────────────────────────────────────────
	it('routes "compare X vs Y" to cloud', () => {
		const d = preTurnRoute('compare REST vs GraphQL for this API', 3);
		expect(d).toEqual({ path: 'cloud', reason: 'reasoning' });
	});

	it('routes trade-off question to cloud', () => {
		const d = preTurnRoute('what are the trade-offs between SQL and NoSQL?', 2);
		expect(d).toEqual({ path: 'cloud', reason: 'reasoning' });
	});

	it('routes "step by step" to cloud', () => {
		const d = preTurnRoute('walk me through step by step how JWT auth works', 4);
		expect(d).toEqual({ path: 'cloud', reason: 'reasoning' });
	});

	// ── Context (long thread) ─────────────────────────────────────────────
	it('routes long thread to cloud', () => {
		const d = preTurnRoute('got it, thanks', 20);
		expect(d).toEqual({ path: 'cloud', reason: 'context' });
	});

	it('does NOT route long thread to cloud below threshold', () => {
		const d = preTurnRoute('got it, thanks', 19);
		expect(d).toEqual({ path: 'local' });
	});

	// ── Case insensitivity ────────────────────────────────────────────────
	it('matches pattern regardless of case', () => {
		const d = preTurnRoute("WHY DOESN'T THIS WORK", 2);
		expect(d).toEqual({ path: 'cloud', reason: 'coding' });
	});
});
