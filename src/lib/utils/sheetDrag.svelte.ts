// src/lib/utils/sheetDrag.svelte.ts
//
// Continuous swipe-to-dismiss for bottom sheets (and horizontal drawers via
// `axis`). When a `motion` bridge is provided, finger tracking drives the
// shared spring engine instead of inline CSS transforms.

const VELOCITY_THRESHOLD = 0.4; // px/ms → flick-to-dismiss
const CLOSE_THRESHOLD = 0.25; // ≥25% of sheet height dragged → dismiss
const SCROLL_LOCK_MS = 100;
const SETTLE = 'transform 0.42s cubic-bezier(0.32, 0.72, 0, 1)';
const MIN_H = 200;

function isIOS(): boolean {
	if (typeof navigator === 'undefined') return false;
	return (
		/iP(hone|ad|od)/.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
	);
}

function dampen(v: number): number {
	return 8 * (Math.log(v + 1) - 2);
}

export interface SheetMotionBridge {
	setDragPosition: (deltaPx: number) => void;
	releaseDrag: (deltaPx: number, velocityPxPerMs: number) => void;
}

export interface SheetDrag {
	handleProps: {
		onpointerdown: (e: PointerEvent) => void;
		onpointermove: (e: PointerEvent) => void;
		onpointerup: (e: PointerEvent) => void;
		onpointercancel: (e: PointerEvent) => void;
	};
	bodyProps: {
		onpointerdown: (e: PointerEvent) => void;
		onpointermove: (e: PointerEvent) => void;
		onpointerup: (e: PointerEvent) => void;
		onpointercancel: (e: PointerEvent) => void;
	};
	bodyAction: (node: HTMLElement) => { destroy(): void };
	readonly isDragging: boolean;
}

export function createSheetDrag(opts: {
	/** Legacy dismiss — used when `motion` bridge is absent (RunSheet, etc.) */
	onDismiss: () => void;
	isEnabled?: () => boolean;
	/** Spring bridge — finger tracking drives shared motion engine */
	motion?: SheetMotionBridge;
	axis?: 'x' | 'y';
}): SheetDrag {
	const axis = opts.axis ?? 'y';
	let sheet: HTMLElement | null = null;
	let start = 0;
	let last = 0;
	let prev = 0;
	let prevT = 0;
	let startT = 0;
	let releaseVelocity = 0;
	let dragging = false;
	let locked = false;
	let lockAt = 0;
	let captureEl: HTMLElement | null = null;
	let capId = -1;

	const ui = $state({ dragging: false });

	function resolveSheet(e: PointerEvent): HTMLElement | null {
		if (sheet) return sheet;
		const el = (e.currentTarget as HTMLElement)?.closest('[data-sheet]');
		sheet = el instanceof HTMLElement ? el : null;
		return sheet;
	}

	function delta(client: number): number {
		return client - start;
	}

	function shouldDragSheet(target: EventTarget | null, d: number): boolean {
		if (axis === 'y' && d <= 0) return false;
		if (axis === 'x' && d >= 0) return false;
		if (locked && Date.now() - lockAt < SCROLL_LOCK_MS) return false;
		let el = target as HTMLElement | null;
		const stop = sheet?.parentElement ?? null;
		while (el && el !== stop) {
			if (el.scrollHeight > el.clientHeight && el.scrollTop > 0) {
				locked = true;
				lockAt = Date.now();
				return false;
			}
			if (el === sheet) break;
			el = el.parentElement;
		}
		return true;
	}

	function setTransformLegacy(px: number): void {
		if (!sheet) return;
		sheet.style.transition = 'none';
		if (axis === 'y') {
			const y = px >= 0 ? px : Math.min(dampen(-px) * -1, 0);
			sheet.style.transform = `translate3d(0, ${y}px, 0)`;
		} else {
			const x = px <= 0 ? px : Math.min(dampen(px), 0);
			sheet.style.transform = `translate3d(${x}px, 0, 0)`;
		}
	}

	function settleBackLegacy(): void {
		if (!sheet) return;
		sheet.style.transition = SETTLE;
		sheet.style.transform = 'translate3d(0, 0, 0)';
	}

	function dismissLegacy(): void {
		if (!sheet) {
			opts.onDismiss();
			return;
		}
		sheet.style.transition = SETTLE;
		sheet.style.transform =
			axis === 'y' ? 'translate3d(0, 100%, 0)' : 'translate3d(-100%, 0, 0)';
		let done = false;
		const fin = () => {
			if (done) return;
			done = true;
			opts.onDismiss();
		};
		sheet.addEventListener('transitionend', fin, { once: true });
		setTimeout(fin, 480);
	}

	function begin(e: PointerEvent): void {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		if (opts.isEnabled && !opts.isEnabled()) return;
		resolveSheet(e);
		const client = axis === 'y' ? e.clientY : e.clientX;
		start = last = prev = client;
		startT = prevT = Date.now();
		releaseVelocity = 0;
		dragging = false;
		captureEl = e.currentTarget as HTMLElement;
		capId = e.pointerId;
		try {
			captureEl.setPointerCapture(capId);
		} catch {
			/* capture unsupported */
		}
		if (isIOS()) window.addEventListener('touchend', endNoEvent, { once: true });
	}

	function move(e: PointerEvent): void {
		if (!sheet) return;
		const client = axis === 'y' ? e.clientY : e.clientX;
		const d = delta(client);
		const now = Date.now();
		const dt = Math.max(now - prevT, 1);
		releaseVelocity = (client - prev) / dt;
		prev = client;
		prevT = now;
		last = client;
		if (!dragging) {
			if (!shouldDragSheet(e.target, d)) return;
			dragging = true;
			ui.dragging = true;
		}
		if (opts.motion) {
			opts.motion.setDragPosition(d);
		} else {
			setTransformLegacy(d);
		}
	}

	function bodyTouchMove(e: TouchEvent): void {
		if (dragging) e.preventDefault();
	}

	function finish(client: number): void {
		if (captureEl && capId !== -1) {
			try {
				captureEl.releasePointerCapture(capId);
			} catch {
				/* already released */
			}
		}
		captureEl = null;
		capId = -1;
		if (!dragging || !sheet) {
			dragging = false;
			ui.dragging = false;
			return;
		}
		const d = delta(client);
		const velocity = Math.abs(releaseVelocity);
		const h = Math.max(
			axis === 'y' ? sheet.getBoundingClientRect().height : sheet.getBoundingClientRect().width,
			MIN_H
		);
		dragging = false;
		ui.dragging = false;

		if (opts.motion) {
			opts.motion.releaseDrag(d, velocity);
			return;
		}

		const dismissDir = axis === 'y' ? d > 0 : d < 0;
		if ((velocity > VELOCITY_THRESHOLD && dismissDir) || Math.abs(d) >= h * CLOSE_THRESHOLD) {
			dismissLegacy();
		} else {
			settleBackLegacy();
		}
	}

	function end(e: PointerEvent): void {
		finish(axis === 'y' ? e.clientY : e.clientX);
	}
	function endNoEvent(): void {
		finish(last);
	}
	function cancel(): void {
		if (dragging && !opts.motion) settleBackLegacy();
		dragging = false;
		ui.dragging = false;
		captureEl = null;
		capId = -1;
	}

	function bodyAction(node: HTMLElement): { destroy(): void } {
		node.addEventListener('touchmove', bodyTouchMove, { passive: false });
		return {
			destroy() {
				node.removeEventListener('touchmove', bodyTouchMove);
			}
		};
	}

	const handlers = {
		onpointerdown: begin,
		onpointermove: move,
		onpointerup: end,
		onpointercancel: cancel
	};

	return {
		handleProps: handlers,
		bodyProps: handlers,
		bodyAction,
		get isDragging() {
			return ui.dragging;
		}
	};
}
