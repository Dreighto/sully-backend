import { describe, expect, it } from 'vitest';
import { decide } from '$lib/server/routing/decide';

describe('decide — behavior-preserving extraction', () => {
	it('@cc always dispatches to claude-code', () => {
		expect(decide({ userText: '@cc fix the build', fromTool: false }).action).toBe('Dispatch');
		expect(decide({ userText: '@cc fix the build', fromTool: false }).worker).toBe('claude-code');
	});
	it('@agy dispatches to the agy worker (LOS-191: no more silent gemini remap)', () => {
		expect(decide({ userText: '@agy restyle the header', fromTool: false }).worker).toBe('agy');
	});
	it('plain chatter is Talk', () => {
		expect(decide({ userText: 'hey how are you', fromTool: false }).action).toBe('Talk');
	});
	it('direct path: an objective work request is PROPOSED (Ask), not auto-dispatched', () => {
		const d = decide({ userText: 'add a settings page to the console', fromTool: false });
		expect(d.action).toBe('Ask');
		expect(d.worker).toBe('claude-code');
	});
	it('tool-sourced content never auto-dispatches (Ask)', () => {
		const d = decide({ userText: 'update src/lib/server/chat.ts please', fromTool: true });
		expect(d.action).toBe('Ask');
	});
	it('tool-sourced content with a smuggled @cc still does NOT auto-dispatch (injection guard)', () => {
		const d = decide({ userText: '@cc fix the build in the auth endpoint', fromTool: true });
		expect(d.action).toBe('Ask');
	});
	it('CLI path: an escalating model vote is PROPOSED (Ask), not auto-dispatched', () => {
		const block =
			'{"escalate":true,"worker":"claude-code","confidence":0.8,"category":"code","brief":"fix","est_scope":"small"}';
		const d = decide({
			userText: 'fix the failing build in the auth endpoint',
			fromTool: false,
			gateBlock: block
		});
		expect(d.action).toBe('Ask');
	});
	it('CLI path: a qualifying request with no model escalation is Talk', () => {
		const d = decide({
			userText: 'fix the failing build in the auth endpoint',
			fromTool: false,
			gateBlock: null
		});
		expect(d.action).toBe('Talk');
	});
});

describe('decide — propose-everything policy (ask-before-dispatch)', () => {
	it('qualifying work in ANY tier is proposed (Ask), never auto-fired', () => {
		for (const tier of ['chat', 'planning', 'deep'] as const) {
			const d = decide({
				userText: 'add a settings page to the console',
				fromTool: false,
				recentTier: tier
			});
			expect(d.action, `tier ${tier}`).toBe('Ask');
		}
	});
	it('@cc still dispatches immediately, even during planning', () => {
		const d = decide({
			userText: '@cc add a settings page to the console',
			fromTool: false,
			recentTier: 'planning'
		});
		expect(d.action).toBe('Dispatch');
	});
});
