// src/lib/utils/sheetDrag.svelte.ts
//
// Continuous swipe-down-to-dismiss for a bottom sheet. vaul-faithful gesture
// arbitration, WKWebView (Capacitor IPA) + Safari PWA safe.
//
// Why this exists: svelte-gestures' useSwipe() and a naive pointerup-only
// handler both FAILED on iOS — with no per-region touch-action and no visual
// transform-follow, WebKit reads the in-progress downward drag as a scroll and
// consumes it before the recognizer ever sees a completed swipe. This factory
// replaces both with continuous pointer tracking + correct touch-action.
//
// Architecture (see the sheet that consumes it):
//   container[data-sheet]  — position:fixed, overflow:hidden, touch-action:none,
//                            will-change:transform. THIS is the element we
//                            translateY to follow the finger. Never scrolls.
//     .handle-zone {handleProps}     — touch-action:none, always drags.
//     .header                        — title + X.
//     .body {bodyProps} use:bodyAction — overflow-y:auto, touch-action:pan-y.
//                            Native scroll; a downward drag dismisses ONLY when
//                            the body is scrolled to the top (vaul shouldDrag).
//
// Handlers are PLAIN PROPS (spread), not Svelte actions, because bits-ui
// Dialog.Content accepts neither use: actions nor a reliable bound ref — so we
// resolve the transform target via e.currentTarget.closest('[data-sheet]').

const VELOCITY_THRESHOLD = 0.4; // px/ms → flick-to-dismiss
const CLOSE_THRESHOLD = 0.25; // ≥25% of sheet height dragged → dismiss
const SCROLL_LOCK_MS = 100; // ignore drag briefly after a scroll (momentum overshoot)
const OPEN_GUARD_MS = 450; // don't hijack the enter animation
const SETTLE = 'transform 0.42s cubic-bezier(0.32, 0.72, 0, 1)';
const MIN_H = 200; // clamp so tiny sheets stay dismissible

function isIOS(): boolean {
	if (typeof navigator === 'undefined') return false;
	return (
		/iP(hone|ad|od)/.test(navigator.userAgent) ||
		// iPadOS 13+ reports as Mac; detect via touch points
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
	);
}

/** Rubbery resistance when the sheet is pulled UP past its open position. */
function dampen(v: number): number {
	return 8 * (Math.log(v + 1) - 2);
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
	onDismiss: () => void;
	/** Optional gate — return false to disable dragging (e.g. desktop where the
	 *  surface is a dropdown, not a sheet). Checked on each pointerdown. */
	isEnabled?: () => boolean;
	/** When true, dismiss clears the inline transform and calls onDismiss
	 *  immediately, letting an external Svelte `transition:` animate the exit.
	 *  When false (default), the factory animates translateY(100%) itself
	 *  (correct for bits-ui Dialog which has no exit transition). */
	externalExit?: boolean;
}): SheetDrag {
	let sheet: HTMLElement | null = null; // the [data-sheet] container
	let startY = 0;
	let lastY = 0;
	let startT = 0;
	let dragging = false; // a real sheet-drag is latched
	let locked = false;
	let lockAt = 0;
	const openAt = Date.now();
	let captureEl: HTMLElement | null = null;
	let capId = -1;

	const ui = $state({ dragging: false });

	function resolveSheet(e: PointerEvent): HTMLElement | null {
		if (sheet) return sheet;
		const el = (e.currentTarget as HTMLElement)?.closest('[data-sheet]');
		sheet = el instanceof HTMLElement ? el : null;
		return sheet;
	}

	// vaul shouldDrag: dragging DOWN drags the sheet only when every scrollable
	// ancestor between the touch target and the sheet is at scrollTop 0.
	function shouldDragSheet(target: EventTarget | null, dy: number): boolean {
		if (Date.now() - openAt < OPEN_GUARD_MS) return false; // let enter anim finish
		if (dy <= 0) return false; // only a downward move starts a sheet-drag
		if (locked && Date.now() - lockAt < SCROLL_LOCK_MS) return false;
		let el = target as HTMLElement | null;
		const stop = sheet?.parentElement ?? null;
		while (el && el !== stop) {
			if (el.scrollHeight > el.clientHeight && el.scrollTop > 0) {
				locked = true;
				lockAt = Date.now();
				return false; // a scrollable ancestor isn't at top → let it scroll
			}
			if (el === sheet) break;
			el = el.parentElement;
		}
		return true;
	}

	function setTransform(px: number): void {
		if (!sheet) return;
		sheet.style.transition = 'none';
		const y = px >= 0 ? px : Math.min(dampen(-px) * -1, 0);
		sheet.style.transform = `translate3d(0, ${y}px, 0)`;
	}

	function settleBack(): void {
		if (!sheet) return;
		sheet.style.transition = SETTLE;
		sheet.style.transform = 'translate3d(0, 0, 0)';
	}

	function dismiss(): void {
		// External-exit mode: clear our inline transform and hand off to the
		// component's own Svelte transition for the out animation.
		if (opts.externalExit) {
			if (sheet) {
				sheet.style.transition = '';
				sheet.style.transform = '';
			}
			opts.onDismiss();
			return;
		}
		if (!sheet) {
			opts.onDismiss();
			return;
		}
		sheet.style.transition = SETTLE;
		sheet.style.transform = 'translate3d(0, 100%, 0)';
		let done = false;
		const fin = () => {
			if (done) return;
			done = true;
			opts.onDismiss();
		};
		sheet.addEventListener('transitionend', fin, { once: true });
		setTimeout(fin, 480); // fallback if transitionend is swallowed (WKWebView)
	}

	function begin(e: PointerEvent): void {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		if (opts.isEnabled && !opts.isEnabled()) return;
		resolveSheet(e);
		startY = lastY = e.clientY;
		startT = Date.now();
		dragging = false;
		captureEl = e.currentTarget as HTMLElement;
		capId = e.pointerId;
		try {
			captureEl.setPointerCapture(capId);
		} catch {
			/* capture unsupported — drag still works while finger stays on element */
		}
		if (isIOS()) window.addEventListener('touchend', endNoEvent, { once: true });
	}

	function move(e: PointerEvent): void {
		if (!sheet) return;
		const dy = e.clientY - startY;
		lastY = e.clientY;
		if (!dragging) {
			if (!shouldDragSheet(e.target, dy)) return; // native scroll
			dragging = true;
			ui.dragging = true; // latch: stays true until release
		}
		setTransform(dy);
	}

	// Non-passive touchmove (registered via bodyAction) so preventDefault is
	// honored once we've decided this is a sheet-drag, not a scroll.
	function bodyTouchMove(e: TouchEvent): void {
		if (dragging) e.preventDefault();
	}

	function finish(clientY: number): void {
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
		const dy = clientY - startY;
		const dt = Math.max(Date.now() - startT, 1);
		const velocity = Math.abs(dy) / dt; // px/ms
		const h = Math.max(sheet.getBoundingClientRect().height, MIN_H);
		dragging = false;
		ui.dragging = false;
		if ((velocity > VELOCITY_THRESHOLD && dy > 0) || dy >= h * CLOSE_THRESHOLD) {
			dismiss();
		} else {
			settleBack();
		}
	}

	function end(e: PointerEvent): void {
		finish(e.clientY);
	}
	function endNoEvent(): void {
		finish(lastY);
	}
	function cancel(): void {
		if (dragging) settleBack();
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
