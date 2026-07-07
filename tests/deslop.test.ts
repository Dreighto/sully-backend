import { describe, it, expect } from 'vitest';
import { deSlop } from '../src/lib/server/chat/deslop';

describe('deSlop — em-dash cleanup (no-ai-slop net)', () => {
	it('replaces a tight em-dash with a comma (operator voice case)', () => {
		expect(deSlop('Got it—KFC. Any piece?')).toBe('Got it, KFC. Any piece?');
		expect(deSlop('Exactly—spaying calms her.')).toBe('Exactly, spaying calms her.');
	});
	it('collapses spaced em-dashes', () => {
		expect(deSlop('Got it — KFC.')).toBe('Got it, KFC.');
	});
	it('leaves code fences untouched', () => {
		const s = 'Use this:\n```js\nconst x = a—b; // range\n```\nGot it—done.';
		const out = deSlop(s);
		expect(out).toContain('const x = a—b;'); // code preserved
		expect(out).toContain('Got it, done.'); // prose cleaned
	});
	it('leaves inline code untouched', () => {
		expect(deSlop('Run `a—b` then go—now.')).toBe('Run `a—b` then go, now.');
	});
	it('preserves numeric en-dash ranges', () => {
		expect(deSlop('Season 3–5 is best.')).toBe('Season 3–5 is best.');
	});
	it('no-op when there is nothing to strip', () => {
		expect(deSlop('Plain sentence.')).toBe('Plain sentence.');
	});
});
