import { describe, expect, it } from 'vitest';
import { buildInteractiveAction, classifyActionRisk } from '../src/lib/server/chat/action_risk';

describe('classifyActionRisk', () => {
	it('flags safety-canon destructive commands', () => {
		expect(classifyActionRisk('rm -rf /tmp/foo')).toBe('destructive');
		expect(classifyActionRisk('DROP TABLE users')).toBe('destructive');
		expect(classifyActionRisk('npm run deploy')).toBe('destructive');
		expect(classifyActionRisk('plex :emptyTrash')).toBe('destructive');
	});

	it('treats routine read-only commands as routine', () => {
		expect(classifyActionRisk('ls -la')).toBe('routine');
		expect(classifyActionRisk('cat README.md')).toBe('routine');
		expect(classifyActionRisk('git status')).toBe('routine');
	});

	it('fails closed on empty input', () => {
		expect(classifyActionRisk('')).toBe('destructive');
		expect(classifyActionRisk('   ')).toBe('destructive');
	});
});

describe('buildInteractiveAction', () => {
	it('sets pending status and advisory risk on the payload', () => {
		const action = buildInteractiveAction('git status', 'Check tree before merge');
		expect(action).toEqual({
			command: 'git status',
			reason: 'Check tree before merge',
			status: 'pending',
			risk: 'routine'
		});
	});

	it('classifies destructive commands on the built payload', () => {
		const action = buildInteractiveAction('rm -rf node_modules', 'Clean install');
		expect(action.risk).toBe('destructive');
		expect(action.status).toBe('pending');
	});
});

import { ensureActionRisk } from '../src/lib/server/chat/action_risk';

describe('action risk — bypass + false-positive hardening (review round)', () => {
	it('catches rm flag-order and whitespace variants (no fail-open)', () => {
		for (const c of ['rm -rf /', 'rm -fr ~', 'rm  -rf /data', 'sudo rm -r x', 'RM -RF /']) {
			expect(classifyActionRisk(c)).toBe('destructive');
		}
	});
	it('does NOT flag git add as destructive (dd bypass)', () => {
		expect(classifyActionRisk('git add .')).toBe('routine');
		expect(classifyActionRisk('git add -A')).toBe('routine');
	});
	it('does NOT flag reproduce/product as destructive (prod bypass)', () => {
		expect(classifyActionRisk('cat reproduce-steps.md')).toBe('routine');
		expect(classifyActionRisk('ls products/')).toBe('routine');
	});
	it('still flags genuine prod/deploy/emptyTrash', () => {
		expect(classifyActionRisk('deploy to prod')).toBe('destructive');
		expect(classifyActionRisk('plex :emptyTrash')).toBe('destructive');
	});
	it('ensureActionRisk populates absent risk from command, preserves present', () => {
		expect(ensureActionRisk({ command: 'rm -rf /', reason: 'x', status: 'pending' }).risk).toBe(
			'destructive'
		);
		expect(ensureActionRisk({ command: 'ls', reason: 'x', status: 'pending' }).risk).toBe(
			'routine'
		);
		expect(
			ensureActionRisk({ command: 'rm -rf /', reason: 'x', status: 'pending', risk: 'routine' })
				.risk
		).toBe('routine');
	});
});
