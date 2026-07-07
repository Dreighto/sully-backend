import { describe, expect, it, vi } from 'vitest';

// Promotion is exercised end-to-end in artifact-promotion-e2e.test.ts; here we
// pin the extractForPersist contract used by the local/direct persist sites.
vi.mock('$lib/server/artifactStore', () => ({
	promoteInlineArtifacts: vi.fn((inputs: unknown[]) =>
		(inputs as { header: unknown }[]).map((_, i) => ({
			trace_id: `teacher-${i + 1}`,
			artifact_id: `a${i + 1}`
		}))
	),
	mintTeacherTraceId: vi.fn(() => 'teacher-forced')
}));

import { extractForPersist } from '$lib/server/chat/artifact_sentinel';

describe('extractForPersist', () => {
	it('passes plain text through untouched', () => {
		const out = extractForPersist('just a normal reply', { threadId: 't', taskId: 'k' });
		expect(out.text).toBe('just a normal reply');
		expect(out.artifactTraceId).toBeNull();
	});

	it('strips a well-formed sentinel block and returns the artifact trace id', () => {
		const reply = [
			"Sure. Here's the layout.",
			'',
			'<<<SULLY_ARTIFACT {"type":"doc","title":"Map","language":"markdown"}>>>',
			'# The Map',
			'contents here',
			'<<<END_SULLY_ARTIFACT>>>',
			'',
			'Any part you want to zoom in on?'
		].join('\n');
		const out = extractForPersist(reply, { threadId: 't', taskId: 'k' });
		expect(out.text).not.toContain('SULLY_ARTIFACT');
		expect(out.text).not.toContain('# The Map');
		expect(out.text).toContain("Here's the layout.");
		expect(out.text).toContain('zoom in on');
		expect(out.artifactTraceId).toBe('teacher-1');
	});

	it('artifact-only reply gets a placeholder, never the raw sentinel back', () => {
		const onlyBlock =
			'<<<SULLY_ARTIFACT {"type":"doc","title":"Solo"}>>>\nbody\n<<<END_SULLY_ARTIFACT>>>';
		const out = extractForPersist(onlyBlock, {});
		expect(out.text.length).toBeGreaterThan(0);
		expect(out.text).not.toContain('SULLY_ARTIFACT');
		expect(out.artifactTraceId).toBeTruthy();
	});
});
