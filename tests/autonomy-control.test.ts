import { describe, expect, it } from 'vitest';
import { normalizeAutonomy, AUTONOMY_DEFAULT } from '$lib/chat/autonomy';

describe('normalizeAutonomy', () => {
	it('defaults to full-auto for unknown/empty values (operator directive 2026-05-31)', () => {
		expect(normalizeAutonomy(null)).toBe('full-auto');
		expect(normalizeAutonomy('garbage')).toBe('full-auto');
		expect(AUTONOMY_DEFAULT).toBe('full-auto');
	});
	it('accepts the three valid modes', () => {
		expect(normalizeAutonomy('ask')).toBe('ask');
		expect(normalizeAutonomy('auto-safe')).toBe('auto-safe');
		expect(normalizeAutonomy('full-auto')).toBe('full-auto');
	});
});
