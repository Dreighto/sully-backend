// Per-thread scroll position persistence.
//
// Saves scrollTop to localStorage keyed by thread_id so that reopening a
// thread (or switching back to one) lands the operator where they left off
// instead of snapping to the bottom.
//
// Usage pattern in the chat page:
//   - call saveScrollPos(threadId, feedContainer.scrollTop) before clearing messages
//   - call restoreScrollPos(threadId, feedContainer) after messages are loaded
//
// The sentinel-at-bottom check (userAtBottom) takes priority: if the thread's
// last position was at the bottom, we scroll to bottom as usual. We only
// restore mid-thread positions.

const KEY_PREFIX = 'sully-scroll-';
const MAX_STORED = 50; // cap to avoid unbounded localStorage growth

function key(threadId: string): string {
	return `${KEY_PREFIX}${threadId}`;
}

/** Persist scrollTop for a thread. Call BEFORE clearing messages. */
export function saveScrollPos(threadId: string, scrollTop: number): void {
	if (!threadId || typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(key(threadId), String(Math.round(scrollTop)));
		// Prune oldest entries if we exceed the cap.
		const allKeys = Object.keys(localStorage).filter((k) => k.startsWith(KEY_PREFIX));
		if (allKeys.length > MAX_STORED) {
			// Remove the first one (arbitrary FIFO).
			localStorage.removeItem(allKeys[0]);
		}
	} catch {
		/* localStorage unavailable or full — silent */
	}
}

/**
 * Restore saved scrollTop for a thread. Call AFTER messages are rendered.
 * Returns the restored position, or null if none was stored (in which case
 * the caller should scroll to bottom as normal).
 */
export function restoreScrollPos(threadId: string, container: HTMLElement | null): number | null {
	if (!threadId || !container || typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(key(threadId));
		if (raw === null) return null;
		const pos = parseInt(raw, 10);
		if (isNaN(pos) || pos <= 0) return null;
		// Only restore if the saved position is meaningfully above the bottom
		// (within 64px of bottom = treat as "was at bottom", scroll to bottom).
		const atBottom = container.scrollHeight - container.clientHeight - pos <= 64;
		if (atBottom) {
			localStorage.removeItem(key(threadId));
			return null;
		}
		container.scrollTop = pos;
		return pos;
	} catch {
		return null;
	}
}

/** Clear the saved position for a thread (e.g. when the operator reaches the bottom). */
export function clearScrollPos(threadId: string): void {
	if (!threadId || typeof localStorage === 'undefined') return;
	try {
		localStorage.removeItem(key(threadId));
	} catch {
		/* silent */
	}
}
