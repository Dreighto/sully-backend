import { describe, expect, it } from 'vitest';
import { decide } from '$lib/server/routing/decide';

describe('decide — behavior-preserving extraction', () => {
	it('@cc always dispatches to claude-code', () => {
		expect(decide({ userText: '@cc fix the build', fromTool: false }).action).toBe('Dispatch');
		expect(decide({ userText: '@cc fix the build', fromTool: false }).worker).toBe('claude-code');
	});
	it('@agy dispatches to gemini', () => {
		expect(decide({ userText: '@agy restyle the header', fromTool: false }).worker).toBe('gemini');
	});
	it('plain chatter is Talk', () => {
		expect(decide({ userText: 'hey how are you', fromTool: false }).action).toBe('Talk');
	});
	it('direct path: an objective work request dispatches to claude-code', () => {
		const d = decide({ userText: 'add a settings page to the console', fromTool: false });
		expect(d.action).toBe('Dispatch');
		expect(d.worker).toBe('claude-code');
	});
	it('tool-sourced content never auto-dispatches (Ask)', () => {
		const d = decide({ userText: 'update src/lib/server/chat.ts please', fromTool: true });
		expect(d.action).toBe('Ask');
	});
	it('CLI path: dispatches only when the model gate validates AND escalates', () => {
		const block =
			'{"escalate":true,"worker":"claude-code","confidence":0.8,"category":"code","brief":"fix","est_scope":"small"}';
		const d = decide({
			userText: 'fix the failing build in the auth endpoint',
			fromTool: false,
			gateBlock: block
		});
		expect(d.action).toBe('Dispatch');
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

describe('decide — tier suppression (safe fix A)', () => {
	it('a qualifying request during planning becomes Ask, not Dispatch', () => {
		const d = decide({
			userText: 'add a settings page to the console',
			fromTool: false,
			recentTier: 'planning'
		});
		expect(d.action).toBe('Ask');
	});
	it('@cc still dispatches even during planning', () => {
		const d = decide({
			userText: '@cc add a settings page to the console',
			fromTool: false,
			recentTier: 'planning'
		});
		expect(d.action).toBe('Dispatch');
	});
	it('chat tier is unaffected (still dispatches)', () => {
		const d = decide({
			userText: 'add a settings page to the console',
			fromTool: false,
			recentTier: 'chat'
		});
		expect(d.action).toBe('Dispatch');
	});
});
