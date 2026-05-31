import { describe, expect, it } from 'vitest';
import { reconcileRows } from '$lib/chat/dispatchReconcile';

describe('reconcileRows', () => {
	it('appends only rows with seq greater than the current cursor', () => {
		const existing = [{ seq: 1, action: 'reading', target: 'a' }];
		const fresh = [
			{ seq: 1, action: 'reading', target: 'a' },
			{ seq: 2, action: 'edited', target: 'b' }
		];
		const { rows, cursor } = reconcileRows(existing, fresh, 1);
		expect(rows.map((r) => r.seq)).toEqual([1, 2]);
		expect(cursor).toBe(2);
	});

	it('dedupes a replayed row already present', () => {
		const existing = [{ seq: 1, action: 'reading', target: 'a' }];
		const fresh = [{ seq: 1, action: 'reading', target: 'a' }];
		const { rows } = reconcileRows(existing, fresh, 1);
		expect(rows).toHaveLength(1);
	});
});
