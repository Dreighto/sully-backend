import { describe, expect, it } from 'vitest';
import { rubberBandOverscroll, rubberBandClamped } from '../src/lib/motion/rubberBand';

describe('rubberBand', () => {
	it('returns 0 for non-positive overscroll', () => {
		expect(rubberBandOverscroll(0, 400)).toBe(0);
		expect(rubberBandOverscroll(-5, 400)).toBe(0);
	});

	it('resists with diminishing returns past open', () => {
		const dim = 400;
		const full = rubberBandOverscroll(80, dim);
		expect(full).toBeGreaterThan(0);
		expect(full).toBeLessThan(80);
	});

	it('clamps between open and closed with rubber past bounds', () => {
		const open = 0;
		const closed = 300;
		const dim = 300;
		expect(rubberBandClamped(150, open, closed, dim)).toBe(150);
		expect(rubberBandClamped(-40, open, closed, dim)).toBeLessThan(0);
		expect(rubberBandClamped(350, open, closed, dim)).toBeGreaterThan(closed);
	});
});

describe('springValue (logic via module export)', () => {
	it('spring module exports createSpringValue', async () => {
		const mod = await import('../src/lib/motion/springValue.svelte');
		expect(typeof mod.createSpringValue).toBe('function');
	});

	it('spring tick uses rAF timestamps with clamped dt (not fixed 1/60)', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync('src/lib/motion/springValue.svelte.ts', 'utf8');
		expect(src).toContain('function tick(now: number)');
		expect(src).toContain('lastTs');
		expect(src).toContain('maxDtSec');
		expect(src).not.toMatch(/function tick\(\)[\s\S]*const dt = 1 \/ 60/);
	});

	it('per-frame position is a plain number delivered via onFrame (no $state in hot path)', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync('src/lib/motion/springValue.svelte.ts', 'utf8');
		// 120Hz contract: position must NOT round-trip through Svelte reactivity.
		expect(src).not.toMatch(/let pos = \$state/);
		expect(src).toContain('setOnFrame');
		expect(src).toContain('emitFrame');
		// The mount gate stays reactive — start/rest only, not per frame.
		expect(src).toMatch(/let animating = \$state/);
	});
});

describe('springPanel drives the DOM imperatively', () => {
	it('exposes attach actions instead of $derived transform/scrimOpacity', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync('src/lib/motion/springPanel.svelte.ts', 'utf8');
		expect(src).toContain('attachSheet');
		expect(src).toContain('attachScrim');
		expect(src).not.toMatch(/transform = \$derived/);
		expect(src).not.toMatch(/scrimOpacity = \$derived/);
		// will-change held during animation, dropped at rest.
		expect(src).toContain('setWillChange');
		// Heavy backdrop blur flattened on the moving sheet during motion.
		expect(src).toContain('panel-flatten');
	});
});

describe('motion surfaces use spring engine not keyframes', () => {
	it('ModelPickerChip uses attach actions, no keyframes, no per-frame style bindings', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync('src/lib/components/ModelPickerChip.svelte', 'utf8');
		expect(src).not.toContain('mpc-closing');
		expect(src).not.toContain('@keyframes mpc-sheet');
		expect(src).toContain('createSpringPanel');
		expect(src).toContain('use:panel.attachSheet');
		expect(src).toContain('use:panel.attachScrim');
		expect(src).not.toContain('style:transform={panel');
		expect(src).not.toContain('style:opacity={panel');
	});

	it('ThreadsSidebar uses attach actions, no keyframes, no per-frame style bindings', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync('src/lib/components/ThreadsSidebar.svelte', 'utf8');
		expect(src).not.toContain('ts-closing');
		expect(src).not.toContain('data-sidebar-state');
		expect(src).not.toContain('ts-sidebar-out');
		expect(src).toContain('createSpringPanel');
		expect(src).toContain('use:panel.attachSheet');
		expect(src).toContain('use:panel.attachScrim');
		expect(src).not.toContain('style:transform={');
		expect(src).not.toContain('style:opacity={panel');
	});

	it('sheetDrag supports motion bridge without externalExit', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync('src/lib/utils/sheetDrag.svelte.ts', 'utf8');
		expect(src).not.toContain('externalExit');
		expect(src).toContain('SheetMotionBridge');
	});
});
