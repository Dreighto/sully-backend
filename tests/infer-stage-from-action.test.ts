import { inferStageFromAction } from '../src/lib/work-surface/chatBridge.svelte';
import { describe, it, expect } from 'vitest'; // Assuming Vitest is used based on SvelteKit

describe('inferStageFromAction', () => {
	it('should map "thinking" to "Read"', () => {
		expect(inferStageFromAction('thinking')).toBe('Read');
	});

	it('should map "task_proposed" to "Read"', () => {
		expect(inferStageFromAction('task_proposed')).toBe('Read');
	});

	it('should map "classifier_ran" to "Read"', () => {
		expect(inferStageFromAction('classifier_ran')).toBe('Read');
	});

	it('should map "reading" to "Read"', () => {
		expect(inferStageFromAction('reading')).toBe('Read');
	});

	it('should map "tool_invoked" to "Build"', () => {
		expect(inferStageFromAction('tool_invoked')).toBe('Build');
	});

	it('should map "tool_result" to "Build"', () => {
		expect(inferStageFromAction('tool_result')).toBe('Build');
	});

	it('should map "edited" to "Build"', () => {
		expect(inferStageFromAction('edited')).toBe('Build');
	});

	it('should map "running" to "Build"', () => {
		expect(inferStageFromAction('running')).toBe('Build');
	});

	it('should map "ran" to "Build"', () => {
		expect(inferStageFromAction('ran')).toBe('Build');
	});

	it('should map "shell" to "Build"', () => {
		expect(inferStageFromAction('shell')).toBe('Build');
	});

	it('should map "write_file" to "Build" (implied existing)', () => {
		expect(inferStageFromAction('write_file')).toBe('Build');
	});
	it('should map "write_config_foo" to "Build" (implied existing)', () => {
		expect(inferStageFromAction('write_config_foo')).toBe('Build');
	});

	it('should map "read_config" to "Read" (implied existing)', () => {
		expect(inferStageFromAction('read_config')).toBe('Read');
	});
	it('should map "read_manifest_bar" to "Read" (implied existing)', () => {
		expect(inferStageFromAction('read_manifest_bar')).toBe('Read');
	});

	it('should map "verification_poll" to "Check"', () => {
		expect(inferStageFromAction('verification_poll')).toBe('Check');
	});

	it('should map "adversary_reviewed" to "Check"', () => {
		expect(inferStageFromAction('adversary_reviewed')).toBe('Check');
	});

	it('should map "finalizing" to "Reply"', () => {
		expect(inferStageFromAction('finalizing')).toBe('Reply');
	});

	it('should map "complete" to "Reply"', () => {
		expect(inferStageFromAction('complete')).toBe('Reply');
	});

	it('should map "completed" to "Reply"', () => {
		expect(inferStageFromAction('completed')).toBe('Reply');
	});

	it('should map "synthesis_completed" to "Reply"', () => {
		expect(inferStageFromAction('synthesis_completed')).toBe('Reply');
	});

	it('should map "reply_persisted" to "Reply"', () => {
		expect(inferStageFromAction('reply_persisted')).toBe('Reply');
	});

	it('should map "turn_decision_shadow" to null', () => {
		expect(inferStageFromAction('turn_decision_shadow')).toBe(null);
	});

	it('should map "gate_evaluated" to null', () => {
		expect(inferStageFromAction('gate_evaluated')).toBe(null);
	});

	it('should return null for an unrecognized action', () => {
		expect(inferStageFromAction('unknown_action_xyz')).toBe(null);
	});

	it('should handle casing and trimming for new mappings', () => {
		expect(inferStageFromAction(' Thinking ')).toBe('Read');
		expect(inferStageFromAction(' TOOL_INVOKED ')).toBe('Build');
		expect(inferStageFromAction(' COMPLETE ')).toBe('Reply');
	});

	it('should handle casing and trimming for existing mappings', () => {
		expect(inferStageFromAction(' READ_SOMETHING ')).toBe('Read');
		expect(inferStageFromAction(' WRITE_SOMETHING ')).toBe('Build');
	});
});
