/**
 * Feed scroll helpers — iOS-safe: no native smooth scroll (kills momentum).
 */

const USER_SCROLL_IDLE_MS = 150;
const JUMP_DURATION_MS = 180;

/** Cubic-out ease for deliberate jump-to-latest */
function easeOutCubic(t: number): number {
	return 1 - Math.pow(1 - t, 3);
}

export type FeedScrollController = {
	markUserScroll: () => void;
	isUserScrolling: () => boolean;
	scrollToBottomInstant: (container: HTMLElement | null) => void;
	scrollToBottomAnimated: (container: HTMLElement | null) => void;
};

export function createFeedScrollController(): FeedScrollController {
	let lastUserScrollAt = 0;
	let jumpRaf = 0;

	function markUserScroll() {
		lastUserScrollAt = Date.now();
		if (jumpRaf) {
			cancelAnimationFrame(jumpRaf);
			jumpRaf = 0;
		}
	}

	function isUserScrolling(): boolean {
		return Date.now() - lastUserScrollAt < USER_SCROLL_IDLE_MS;
	}

	function scrollToBottomInstant(container: HTMLElement | null) {
		if (!container) return;
		container.scrollTop = container.scrollHeight;
	}

	function scrollToBottomAnimated(container: HTMLElement | null) {
		if (!container || isUserScrolling()) return;
		if (jumpRaf) cancelAnimationFrame(jumpRaf);

		const start = container.scrollTop;
		const end = container.scrollHeight - container.clientHeight;
		if (end <= start + 1) {
			container.scrollTop = end;
			return;
		}

		const t0 = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - t0) / JUMP_DURATION_MS);
			container.scrollTop = start + (end - start) * easeOutCubic(t);
			if (t < 1) {
				jumpRaf = requestAnimationFrame(step);
			} else {
				jumpRaf = 0;
			}
		};
		jumpRaf = requestAnimationFrame(step);
	}

	return {
		markUserScroll,
		isUserScrolling,
		scrollToBottomInstant,
		scrollToBottomAnimated
	};
}
