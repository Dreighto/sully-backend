import { writable } from 'svelte/store';

export type ToastType = 'info' | 'success' | 'error' | 'warning';

export interface Toast {
	id: string;
	message: string;
	type: ToastType;
	duration?: number;
}

const { subscribe, update } = writable<Toast[]>([]);

// Per-type defaults so error toasts persist long enough for the operator to
// actually read them. Operator caught a Sonnet error during chat that
// vanished before they could see what failed (2026-05-27). Errors now stay
// until manually dismissed; successes/info auto-dismiss quickly so the
// operator's screen doesn't pile up.
const DEFAULT_DURATIONS: Record<ToastType, number> = {
	info: 3000,
	success: 3000,
	warning: 6000,
	error: 0 // sticky — must be tap-dismissed
};

export const toasts = {
	subscribe,
	add: (message: string, type: ToastType = 'info', duration?: number) => {
		const id = crypto.randomUUID();
		const effective = duration ?? DEFAULT_DURATIONS[type];
		update((all) => [{ id, message, type, duration: effective }, ...all]);
		if (effective > 0) {
			setTimeout(() => {
				toasts.remove(id);
			}, effective);
		}
	},
	remove: (id: string) => {
		update((all) => all.filter((t) => t.id !== id));
	}
};
