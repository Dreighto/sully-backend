// Per-message action controller — copy / regenerate / read-aloud. Extracted
// from chat/+page.svelte. Owns the small reactive UI sets that drive each
// message's action-button states (copiedIds, regeneratingIds, speakingId,
// speakLoadingId) plus the imperative read-aloud audio resources.
//
// REACTIVE OWNERSHIP: this module owns only its own button-state $state; the
// page keeps ownership of `messages` and `sending`. Reads/writes of those go
// through the `deps` port (getters for reads, setters for writes) so the
// page's template bindings stay intact. `toasts` is a direct import (same as
// the other controllers).
//
// Behavior is preserved EXACTLY from the inline originals: same endpoints
// (/api/chat?id=… DELETE for regenerate, /api/chat/speak POST for read-aloud),
// same optimistic UI (drop the old reply before re-streaming), same toasts,
// same disabled conditions (regenerate guards on sending || already-regenerating).

import { resolve } from '$app/paths';
import { toasts } from '$lib/utils/toasts';
import type { ChatMessage } from '$lib/types/chat-ui';

export interface MessageActionsDeps {
	getMessages: () => ChatMessage[];
	setMessages: (next: ChatMessage[]) => void;
	getSending: () => boolean;
	setSending: (v: boolean) => void;
	/** iOS audio-unlock blip — the tap is the user gesture (voice controller). */
	unlockAudio: () => void;
	/**
	 * The persistent, already-unlocked <audio> element (the one unlockAudio
	 * blesses). Read-aloud MUST play through this same element — iOS only allows
	 * playback on an element unlocked inside the user gesture, so a fresh
	 * `new Audio()` is silently blocked. Returns null pre-mount (SSR/first paint).
	 */
	getAudioEl: () => HTMLAudioElement | null;
	/** Re-stream a reply for the given prior-operator message body. */
	runStream: (messageBody: string) => Promise<void>;
}

export interface MessageActionsController {
	readonly copiedIds: Set<number>;
	readonly regeneratingIds: Set<number>;
	readonly speakingId: number | null;
	readonly speakLoadingId: number | null;
	copyMessage: (m: ChatMessage) => Promise<void>;
	regenerateReply: (m: ChatMessage) => Promise<void>;
	speakMessage: (m: ChatMessage) => Promise<void>;
	/** Operator's thumbs-up / thumbs-down on a reply. signal=0 clears it. */
	feedbackMessage: (m: ChatMessage, signal: 1 | -1 | 0) => Promise<void>;
	stopReadAloud: () => void;
	/** onDestroy hook — stop any in-flight read-aloud. */
	destroy: () => void;
}

export function createMessageActionsController(deps: MessageActionsDeps): MessageActionsController {
	// Set of message ids currently showing the "Copied" check on their copy
	// button. Cleared 1500ms after copy fires.
	let copiedIds = $state(new Set<number>());
	// Regenerate flow — operator clicks "Regenerate" on an AGY reply. We
	// find the prior operator message in the same thread, delete the
	// existing reply, then re-stream a new one. Old reply gets replaced
	// rather than stacking up.
	let regeneratingIds = $state(new Set<number>());
	// Per-message read-aloud (like ChatGPT/Claude). Plays Sully's reply through
	// the local TTS (Chatterbox via /api/chat/speak). Toggle to stop; one at a time.
	let speakingId = $state<number | null>(null);
	let speakLoadingId = $state<number | null>(null);
	let readAloudAudio: HTMLAudioElement | null = null;
	let readAloudUrl: string | null = null;
	let readAloudAbort: AbortController | null = null;

	async function copyMessage(m: ChatMessage) {
		try {
			await navigator.clipboard.writeText(m.message);
			copiedIds = new Set([...copiedIds, m.id]);
			setTimeout(() => {
				copiedIds = new Set([...copiedIds].filter((i) => i !== m.id));
			}, 1500);
		} catch {
			toasts.add('Clipboard unavailable — long-press to copy manually', 'error');
		}
	}

	async function regenerateReply(m: ChatMessage) {
		if (deps.getSending() || regeneratingIds.has(m.id)) return;
		// Find the most recent operator message before this reply.
		const messages = deps.getMessages();
		const idx = messages.findIndex((x) => x.id === m.id);
		if (idx < 0) return;
		let priorOperator: ChatMessage | null = null;
		for (let i = idx - 1; i >= 0; i--) {
			if (messages[i].sender === 'operator') {
				priorOperator = messages[i];
				break;
			}
		}
		if (!priorOperator) {
			toasts.add('No prior message to regenerate from', 'error');
			return;
		}
		regeneratingIds = new Set([...regeneratingIds, m.id]);
		deps.setSending(true);
		try {
			// Drop the old reply server-side + optimistically from the feed so
			// the streamed replacement lands in the right place.
			await fetch(resolve(`/api/chat?id=${m.id}`), { method: 'DELETE' }).catch(() => null);
			deps.setMessages(deps.getMessages().filter((x) => x.id !== m.id));
			await deps.runStream(priorOperator.message);
		} catch (e) {
			toasts.add(`Regenerate failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error');
		} finally {
			deps.setSending(false);
			regeneratingIds = new Set([...regeneratingIds].filter((i) => i !== m.id));
		}
	}

	function stopReadAloud() {
		readAloudAbort?.abort();
		readAloudAbort = null;
		if (readAloudAudio) {
			try {
				readAloudAudio.pause();
				// Detach our handlers but DON'T tear down the shared persistent
				// element (voice mode reuses it) — just release it.
				readAloudAudio.onended = null;
				readAloudAudio.onerror = null;
			} catch {
				/* already stopped */
			}
			readAloudAudio = null;
		}
		if (readAloudUrl) {
			URL.revokeObjectURL(readAloudUrl);
			readAloudUrl = null;
		}
		speakingId = null;
		speakLoadingId = null;
	}

	async function speakMessage(m: ChatMessage) {
		// Tapping the message that's already playing/loading stops it.
		if (speakingId === m.id || speakLoadingId === m.id) {
			stopReadAloud();
			return;
		}
		stopReadAloud();
		const text = (m.message || '').trim();
		if (!text) return;
		deps.unlockAudio(); // iOS audio-unlock — the tap is the user gesture
		speakLoadingId = m.id;
		readAloudAbort = new AbortController();
		try {
			const resp = await fetch(resolve('/api/chat/speak'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text }),
				signal: readAloudAbort.signal
			});
			if (!resp.ok) {
				speakLoadingId = null;
				toasts.add(resp.status === 429 ? 'TTS daily cap reached' : 'Read-aloud failed', 'error');
				return;
			}
			const url = URL.createObjectURL(await resp.blob());
			readAloudUrl = url;
			// Play through the SHARED, already-unlocked <audio> element. iOS only
			// permits playback on an element blessed inside the tap gesture (which
			// unlockAudio() did above) — a fresh `new Audio()` here rejects on
			// play() after the async TTS fetch (the "spinner then error" symptom).
			// Fall back to a transient element only when the shared one isn't
			// mounted (e.g. SSR/first paint), which is the non-iOS case anyway.
			const audio = deps.getAudioEl() ?? new Audio();
			audio.src = url;
			readAloudAudio = audio;
			const revoke = () => {
				if (readAloudUrl === url) {
					URL.revokeObjectURL(url);
					readAloudUrl = null;
				}
			};
			audio.onended = () => {
				if (speakingId === m.id) speakingId = null;
				if (readAloudAudio === audio) readAloudAudio = null;
				revoke();
			};
			audio.onerror = revoke;
			speakLoadingId = null;
			speakingId = m.id;
			await audio.play();
		} catch (e) {
			if ((e as Error).name !== 'AbortError') toasts.add('Read-aloud unavailable', 'error');
			if (speakLoadingId === m.id) speakLoadingId = null;
			if (speakingId === m.id) speakingId = null;
		}
	}

	async function feedbackMessage(m: ChatMessage, signal: 1 | -1 | 0) {
		// Optimistic update — flip the icon immediately, roll back on error.
		const stored = signal === 0 ? null : signal;
		const prior = m.quality_signal ?? null;
		const apply = (next: number | null) =>
			deps.setMessages(
				deps.getMessages().map((x) => (x.id === m.id ? { ...x, quality_signal: next } : x))
			);
		apply(stored);
		try {
			const resp = await fetch(resolve('/api/chat/feedback'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message_id: m.id, signal })
			});
			if (!resp.ok) throw new Error(`feedback ${resp.status}`);
		} catch {
			apply(prior);
			toasts.add('Feedback not saved — try again', 'error');
		}
	}

	return {
		get copiedIds() {
			return copiedIds;
		},
		get regeneratingIds() {
			return regeneratingIds;
		},
		get speakingId() {
			return speakingId;
		},
		get speakLoadingId() {
			return speakLoadingId;
		},
		copyMessage,
		regenerateReply,
		speakMessage,
		feedbackMessage,
		stopReadAloud,
		destroy: () => stopReadAloud()
	};
}
