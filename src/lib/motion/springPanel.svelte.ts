// Shared spring-driven panel controller (bottom sheets + side drawers).
// Present while logically open OR the spring is still animating toward rest.
//
// HOT PATH (120Hz): per-frame values reach the DOM via direct el.style writes
// inside the spring's onFrame — never through $state/$derived/template
// bindings (see springValue.svelte.ts). The only reactive surface left is
// `present` (mount gate, flips ~twice per interaction via spring.isAnimating
// and getOpen()).

import { createSpringValue, type SpringValue } from './springValue.svelte';
import { rubberBandClamped } from './rubberBand';

export type PanelAxis = 'y' | 'x';

export type SpringPanel = {
	readonly spring: SpringValue;
	readonly present: boolean;
	/** Svelte action — the moving surface. Writes transform imperatively. */
	attachSheet: (node: HTMLElement) => { destroy(): void };
	/** Svelte action — optional scrim. Writes opacity imperatively. */
	attachScrim: (node: HTMLElement) => { destroy(): void };
	setClosedSize: (px: number) => void;
	requestClose: (velocityPxPerSec?: number) => void;
	animateOpen: () => void;
	setDragPosition: (dragDeltaPx: number) => void;
	releaseDrag: (dragDeltaPx: number, velocityPxPerMs: number) => void;
};

const CLOSE_THRESHOLD = 0.25;
const VELOCITY_THRESHOLD = 0.4;

export function createSpringPanel(opts: {
	getOpen: () => boolean;
	setOpen: (open: boolean) => void;
	axis: PanelAxis;
	fallbackClosedSize?: number;
	/** When false, skip style writes and clear inline transform (e.g. desktop static sidebar). */
	isEnabled?: () => boolean;
}): SpringPanel {
	const openPos = 0;
	const fallback = opts.fallbackClosedSize ?? (opts.axis === 'y' ? 480 : 288);
	const enabled = opts.isEnabled ?? (() => true);
	let closedSizePx = fallback;
	let prevOpen = false;

	let sheetEl: HTMLElement | null = null;
	let scrimEl: HTMLElement | null = null;
	let willChangeOn = false;

	const closedPos = (): number => (opts.axis === 'y' ? closedSizePx : -closedSizePx);

	function transformFor(v: number): string {
		return opts.axis === 'y' ? `translate3d(0, ${v}px, 0)` : `translate3d(${v}px, 0, 0)`;
	}

	function opacityFor(v: number): number {
		const closed = closedPos();
		if (closed === 0) return opts.getOpen() ? 1 : 0;
		if (opts.axis === 'x') {
			return 1 - Math.min(1, Math.max(0, Math.abs(v / closed)));
		}
		return 1 - Math.min(1, Math.max(0, v / closed));
	}

	function writeFrame(v: number) {
		if (!enabled()) return;
		if (sheetEl) sheetEl.style.transform = transformFor(v);
		if (scrimEl) scrimEl.style.opacity = String(opacityFor(v));
	}

	function setWillChange(on: boolean) {
		willChangeOn = on;
		if (sheetEl) {
			sheetEl.style.willChange = on ? 'transform' : '';
			// Stylesheet transitions on transform would re-ease every per-frame
			// write (the vaul "transition: none during drag" rule, generalized).
			sheetEl.style.transitionProperty = on ? 'none' : '';
			// Heavy backdrop-filter on the MOVING element forces the GPU to
			// re-blur the whole backdrop every frame — the 120Hz killer. Flatten
			// the sheet's own blur during motion, restore glass at rest. Scrim
			// stays blurred (light + stationary).
			sheetEl.classList.toggle('panel-flatten', on);
		}
	}

	const spring = createSpringValue(closedPos(), { stiffness: 170, damping: 26, mass: 1 });
	spring.setOnFrame(writeFrame);

	const present = $derived(opts.getOpen() || spring.isAnimating);

	function dimension(): number {
		return Math.max(closedSizePx, 200);
	}

	/** Start a spring with will-change held for the duration of the animation. */
	function animate(target: number, velocityPxPerSec: number) {
		setWillChange(true);
		spring.animateTo(target, velocityPxPerSec, () => setWillChange(false));
	}

	function animateOpen() {
		spring.set(closedPos());
		animate(openPos, 0);
	}

	function requestClose(velocityPxPerSec = 0) {
		opts.setOpen(false);
		animate(closedPos(), velocityPxPerSec);
	}

	function setDragPosition(dragDeltaPx: number) {
		const closed = closedPos();
		const pos = rubberBandClamped(dragDeltaPx, openPos, closed, dimension());
		setWillChange(true);
		spring.set(pos);
	}

	function releaseDrag(dragDeltaPx: number, velocityPxPerMs: number) {
		const dim = dimension();
		const closed = closedPos();
		const dismissDown = opts.axis === 'y' && dragDeltaPx > 0;
		const dismissLeft = opts.axis === 'x' && dragDeltaPx < 0;
		const distance = opts.axis === 'y' ? dragDeltaPx : Math.abs(dragDeltaPx);
		const shouldDismiss =
			(velocityPxPerMs > VELOCITY_THRESHOLD && (dismissDown || dismissLeft)) ||
			distance >= dim * CLOSE_THRESHOLD;

		const velPxPerSec = velocityPxPerMs * 1000;

		if (shouldDismiss && (dismissDown || dismissLeft)) {
			opts.setOpen(false);
			animate(closed, velPxPerSec);
		} else {
			const sign = opts.axis === 'y' ? (dragDeltaPx >= 0 ? 1 : -1) : dragDeltaPx >= 0 ? 1 : -1;
			animate(openPos, velPxPerSec * sign);
		}
	}

	// $effect.pre on purpose: on an EXTERNAL close (parent flips open=false
	// without going through requestClose/releaseDrag) the close animation must
	// start — making spring.isAnimating true — BEFORE the template evaluates
	// `present`, or the {#if present} block unmounts for a frame and the sheet
	// vanishes instead of animating out. Pre-effects run before DOM updates.
	$effect.pre(() => {
		const isOpen = opts.getOpen();
		if (isOpen && !prevOpen) {
			animateOpen();
		} else if (!isOpen && prevOpen) {
			// requestClose / releaseDrag already started a spring toward closed —
			// do not overwrite injected release velocity.
			const closed = closedPos();
			if (!spring.isAnimating && Math.abs(spring.value - closed) > 1) {
				animate(closed, 0);
			}
		}
		prevOpen = isOpen;
	});

	// Reactive-flush sentinel for the instrumented e2e. `spring.value` is a
	// plain (non-reactive) getter, so this effect re-runs ONLY when getOpen()
	// flips. If the per-frame position ever becomes $state again, this effect
	// re-runs every frame and the motion-engine e2e fails on the flush count.
	$effect(() => {
		void spring.value;
		void opts.getOpen();
		if (typeof window !== 'undefined') {
			const w = window as unknown as { __motionReactiveFlushes?: number };
			w.__motionReactiveFlushes = (w.__motionReactiveFlushes ?? 0) + 1;
		}
	});

	return {
		get spring() {
			return spring;
		},
		get present() {
			return present;
		},
		attachSheet(node: HTMLElement) {
			sheetEl = node;
			if (enabled()) {
				node.style.transform = transformFor(spring.value);
				node.style.willChange = willChangeOn ? 'transform' : '';
				node.style.transitionProperty = willChangeOn ? 'none' : '';
				// The model sheet mounts AFTER animateOpen starts — re-apply the
				// motion-flatten state so the opening slide is already blur-free.
				node.classList.toggle('panel-flatten', willChangeOn);
			} else {
				node.style.transform = '';
				node.style.willChange = '';
				node.style.transitionProperty = '';
				node.classList.remove('panel-flatten');
			}
			return {
				destroy() {
					if (sheetEl === node) sheetEl = null;
				}
			};
		},
		attachScrim(node: HTMLElement) {
			scrimEl = node;
			if (enabled()) node.style.opacity = String(opacityFor(spring.value));
			return {
				destroy() {
					if (scrimEl === node) scrimEl = null;
				}
			};
		},
		setClosedSize(px: number) {
			if (px > 0) closedSizePx = px;
		},
		requestClose,
		animateOpen,
		setDragPosition,
		releaseDrag
	};
}
