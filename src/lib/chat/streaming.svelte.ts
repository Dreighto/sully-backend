// Streaming controller — owns the SDK Chat transport + the in-flight stream
// state + the stream-mirror $effect + runStreamingSend. Extracted from
// chat/+page.svelte (PR E4).
//
// Why the controller doesn't own `messages`: three places write to the rendered
// feed (streaming's placeholder + token mirror, composer's send confirms, the
// background pollMessages reconciler). Keeping `messages` page-owned + writing
// through a setMessages dep keeps reactive ownership in one place.
//
// Stale-closure trap WORTH CALLING OUT: DefaultChatTransport's body+headers
// callbacks fire at SDK send time, not factory time. They MUST invoke the
// deps' getters per call so the body picks up the CURRENT activeThread /
// providerOverride / toolsKey — not snapshots at construction. The closures
// here read deps.getX() inline; do not let any "optimization" cache them.
//
// Self-loop trap: the stream-mirror $effect reads sdkChat.messages AND writes
// the page's messages. The write is wrapped in untrack() so reading messages
// while computing the new array doesn't re-subscribe and blow effect_update_
// depth. (Same pattern as the original inline effect — preserve verbatim.)

import { Chat } from '@ai-sdk/svelte';
import { DefaultChatTransport } from 'ai';
import { resolve } from '$app/paths';
import { toasts } from '$lib/utils/toasts';
import { untrack } from 'svelte';
import { providerPrefToApi } from './model-registry';
import type { ChatMessage, ProviderPref } from '$lib/types/chat-ui';

export interface StreamingDeps {
	getActiveThread: () => string;
	getSelectedRepo: () => string;
	getProviderOverride: () => ProviderPref;
	getModelOverride: () => string | null;
	getToolsKey: () => string;
	getMessages: () => ChatMessage[];
	getUserAtBottom: () => boolean;
	setMessages: (next: ChatMessage[]) => void;
	pollMessages: () => Promise<void>;
	scrollToBottom: () => void;
}

type StreamState = { placeholderId: number; threadId: string } | null;

export interface StreamingController {
	readonly streamState: StreamState;
	/** Exposed so the template can iterate tool-call chips during a stream. */
	readonly sdkChat: Chat;
	/** True iff a stream is in flight for the given thread (poll race guard). */
	isStreamingFor: (threadId: string) => boolean;
	/** Send a message through the SDK stream. Resolves when the stream finishes. */
	run: (messageBody: string) => Promise<void>;
	/**
	 * Cancel the in-flight stream. Operator-facing — wired to the composer's
	 * send-button-becomes-stop affordance + the 90s safety timeout.
	 * Resolves `run()`'s awaited sendMessage via an AbortError that the
	 * catch handler classifies as "Stream cancelled."
	 */
	abort: () => void;
	destroy: () => void;
}

export function createStreamingController(deps: StreamingDeps): StreamingController {
	let streamState = $state<StreamState>(null);

	const sdkChat = new Chat({
		transport: new DefaultChatTransport({
			api: resolve('/api/chat/sdk-stream'),
			// IMPORTANT: SDK 6's Chat class does NOT accept `api`/`body` shorthand
			// at the top level (those are silently ignored — caused PR 2b.2's
			// first-run bug). Use DefaultChatTransport.
			body: () => {
				const provider = deps.getProviderOverride();
				return {
					thread: deps.getActiveThread(),
					target_repo: deps.getSelectedRepo(),
					provider: providerPrefToApi(provider),
					model: deps.getModelOverride() ?? undefined
				};
			},
			// Per-device tools-unlock code (set via /unlock). Sent only when
			// present so the companion's file-read + web tools turn on for this
			// device. Per-call getter so /unlock takes effect immediately.
			headers: (): Record<string, string> => {
				const key = deps.getToolsKey();
				return key ? { 'x-companion-tools-key': key } : {};
			}
		})
	});

	// Mirror the SDK stream's tokens into the placeholder bubble in `messages`.
	// untrack() the messages write so reading messages while computing the new
	// array doesn't self-trigger. Re-runs only when sdkChat.messages changes.
	$effect(() => {
		if (streamState === null) return;
		const list = sdkChat.messages;
		const lastIdx = list.length - 1;
		if (lastIdx < 0) return;
		const last = list[lastIdx];
		if (last.role !== 'assistant') return;
		const txt = (last.parts || [])
			.filter((p) => p.type === 'text')
			.map((p) => (p as { type: 'text'; text: string }).text)
			.join('');
		if (!txt) return;
		const id = streamState.placeholderId;
		untrack(() => {
			const prev = deps.getMessages();
			deps.setMessages(prev.map((m) => (m.id === id ? { ...m, message: txt } : m)));
		});
		if (deps.getUserAtBottom()) {
			queueMicrotask(() => deps.scrollToBottom());
		}
	});

	async function run(messageBody: string): Promise<void> {
		const STREAM_ID = Date.now() + 1; // distinct from the operator's optimistic id
		// Insert an empty placeholder; tokens will append. With this bubble
		// present, the thinking-dots indicator suppresses (last msg !== operator).
		// Sender derived from active provider so the bubble label (AGY / CC)
		// matches what the SDK endpoint will persist.
		const provider = deps.getProviderOverride();
		const placeholderSender: ChatMessage['sender'] =
			provider === 'anthropic' ? 'cc' : provider === 'local' ? 'local' : 'agy';
		const prev = deps.getMessages();
		deps.setMessages([
			...prev,
			{
				id: STREAM_ID,
				sender: placeholderSender,
				message: '',
				timestamp: new Date().toISOString()
			} as ChatMessage
		]);
		streamState = { placeholderId: STREAM_ID, threadId: deps.getActiveThread() };

		// Reset SDK chat history before each send — the server assembles the
		// real context from chat_messages DB. We use sdkChat strictly as a
		// streaming transport, not a context store. Without the reset, each
		// send would carry the previous SDK turns as duplicate body.messages.
		sdkChat.messages = [];

		let errored = false;
		try {
			await sdkChat.sendMessage({ text: messageBody });
		} catch (err) {
			errored = true;
			const rawMsg = err instanceof Error ? err.message : 'unknown';
			// Classify the error so the operator gets an actionable toast
			// instead of a generic "LLM stream failed: unknown". Audit
			// 2026-05-27 — expired OAuth used to look identical to a real outage.
			const lower = rawMsg.toLowerCase();
			let toastBody = `LLM stream failed: ${rawMsg}`;
			if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('expired')) {
				toastBody = 'Auth expired — log in again (Anthropic/Gemini OAuth).';
			} else if (
				lower.includes('credential') ||
				lower.includes('not configured') ||
				lower.includes('503')
			) {
				toastBody = `Provider unreachable: ${rawMsg}. Check the upstream service or fall back to another provider.`;
			} else if (lower.includes('429') || lower.includes('rate limit')) {
				toastBody = 'Rate limited by provider. Wait a moment and retry, or switch model.';
			} else if (lower.includes('aborted') || lower.includes('canceled')) {
				toastBody = 'Stream cancelled.';
			}
			toasts.add(toastBody, 'error');
			// Stamp the error into the placeholder bubble.
			const cur = deps.getMessages();
			deps.setMessages(
				cur.map((m) => (m.id === STREAM_ID ? { ...m, message: `⚠️ ${rawMsg}` } : m))
			);
		} finally {
			streamState = null;
			if (errored) {
				const cur = deps.getMessages();
				deps.setMessages(cur.filter((m) => m.id !== STREAM_ID));
			}
		}

		// D2.3: A work turn returns an empty stream (no text-delta events).
		// The placeholder bubble stays message:'' and would show hanging
		// thinking-dots. Delete it now so pollMessages surfaces the proposal
		// card cleanly instead. A normal ANSWER_NOW turn has text → kept.
		if (!errored) {
			const cur = deps.getMessages();
			const placeholder = cur.find((m) => m.id === STREAM_ID);
			if (placeholder && !placeholder.message) {
				deps.setMessages(cur.filter((m) => m.id !== STREAM_ID));
			}
		}

		// Reconcile against the persisted DB state — the SDK endpoint's
		// onFinish callback wrote the assistant row before closing the stream,
		// so pollMessages picks up the canonical numeric-id row and the
		// optimistic STREAM_ID placeholder gets replaced.
		if (!errored) {
			await deps.pollMessages();
		}
	}

	return {
		get streamState() {
			return streamState;
		},
		get sdkChat() {
			return sdkChat;
		},
		isStreamingFor: (threadId: string) => streamState !== null && streamState.threadId === threadId,
		run,
		abort: () => {
			// SDK's Chat.stop() aborts the in-flight fetch; the awaited
			// sendMessage() throws an AbortError, our catch classifies it as
			// "Stream cancelled.", finally clears streamState. Safe to call
			// even when nothing is in flight (no-op).
			try {
				sdkChat.stop();
			} catch {
				/* SDK throws if no stream — harmless */
			}
		},
		destroy: () => {
			/* sdkChat has no explicit close; rely on GC */
		}
	};
}
