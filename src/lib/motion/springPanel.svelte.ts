// Shared spring-driven panel controller (bottom sheets + side drawers).
// Present while logically open OR spring has not settled at the closed position.

import { createSpringValue, type SpringValue } from './springValue.svelte';
import { rubberBandClamped } from './rubberBand';

export type PanelAxis = 'y' | 'x';

export type SpringPanel = {
	readonly spring: SpringValue;
	readonly present: boolean;
	readonly scrimOpacity: number;
	readonly transform: string;
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
}): SpringPanel {
	const openPos = 0;
	const fallback = opts.fallbackClosedSize ?? (opts.axis === 'y' ? 480 : 288);
	let closedSizePx = $state(fallback);
	let prevOpen = false;

	const closedPos = (): number => (opts.axis === 'y' ? closedSizePx : -closedSizePx);

	const spring = createSpringValue(closedPos(), { stiffness: 170, damping: 26, mass: 1 });

	const present = $derived(
		opts.getOpen() ||
			spring.isAnimating ||
			Math.abs(spring.value - closedPos()) > 1
	);

	const scrimOpacity = $derived.by(() => {
		const closed = closedPos();
		if (closed === 0) return opts.getOpen() ? 1 : 0;
		if (opts.axis === 'x') {
			return 1 - Math.min(1, Math.max(0, Math.abs(spring.value / closed)));
		}
		return 1 - Math.min(1, Math.max(0, spring.value / closed));
	});

	const transform = $derived.by(() => {
		const v = spring.value;
		return opts.axis === 'y'
			? `translate3d(0, ${v}px, 0)`
			: `translate3d(${v}px, 0, 0)`;
	});

	function dimension(): number {
		return Math.max(closedSizePx, 200);
	}

	function animateOpen() {
		spring.set(closedPos());
		spring.animateTo(openPos, 0);
	}

	function requestClose(velocityPxPerSec = 0) {
		opts.setOpen(false);
		spring.animateTo(closedPos(), velocityPxPerSec);
	}

	function setDragPosition(dragDeltaPx: number) {
		const closed = closedPos();
		const pos = rubberBandClamped(dragDeltaPx, openPos, closed, dimension());
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
			spring.animateTo(closed, velPxPerSec);
		} else {
			const sign = opts.axis === 'y' ? (dragDeltaPx >= 0 ? 1 : -1) : dragDeltaPx >= 0 ? 1 : -1;
			spring.animateTo(openPos, velPxPerSec * sign);
		}
	}

	$effect(() => {
		const isOpen = opts.getOpen();
		if (isOpen && !prevOpen) {
			animateOpen();
		} else if (!isOpen && prevOpen) {
			// External close (parent set open=false). requestClose / releaseDrag already
			// started a spring toward closed — do not overwrite injected release velocity.
			const closed = closedPos();
			if (!spring.isAnimating && Math.abs(spring.value - closed) > 1) {
				spring.animateTo(closed, 0);
			}
		}
		prevOpen = isOpen;
	});

	return {
		get spring() {
			return spring;
		},
		get present() {
			return present;
		},
		get scrimOpacity() {
			return scrimOpacity;
		},
		get transform() {
			return transform;
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
