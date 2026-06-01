<script lang="ts">
	// Chat Surface V2 — Conversational OS (AGY Redo).
	//
	// Design philosophy:
	//   - Full-bleed immersive canvas. No global chrome.
	//   - Conversation IS the interface.
	//   - Composer is the hero: glowing pill, color-shifting states.
	//   - Solid, readable menus (no transparent text overlays on gradients).
	//   - Glowing orange operator outlines & cyan agent labels.
	//   - Dedicated collapsible left sidebar for threads & pinned sessions.
	//   - 100% wired controls (Paperclip uploads, Sparkles image mode, Talkback loop).

	import { onMount, onDestroy, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { createDispatchStream } from '$lib/chat/dispatchStream.svelte';
	import { parseDbTimestamp } from '$lib/utils/format';
	import type { SlashCmd } from '$lib/types/slash';
	import type {
		Tier,
		Attachment,
		ComposerMode,
		ProviderPref,
		ModelChoice,
		ChatMessage
	} from '$lib/types/chat-ui';
	import { MODEL_CHOICES } from '$lib/chat/model-choices';
	import { createThreadsController } from '$lib/chat/threads.svelte';
	import { createSlashCommandsController } from '$lib/chat/slash-commands';
	import { createComposerStateController } from '$lib/chat/composer-state.svelte';
	import { createStreamingController } from '$lib/chat/streaming.svelte';
	import { createVoiceController } from '$lib/chat/voice.svelte';
	import { createRealtimeVoiceController } from '$lib/chat/realtime-voice.svelte';
	import { createMessageActionsController } from '$lib/chat/message-actions.svelte';
	import { replaceState } from '$app/navigation';
	import { toasts } from '$lib/utils/toasts';
	import Canvas from '$lib/components/Canvas.svelte';
	import WorkspaceContextModal from '$lib/components/WorkspaceContextModal.svelte';
	import ThreadsSidebar from '$lib/components/ThreadsSidebar.svelte';
	import ChatHeader from '$lib/components/ChatHeader.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import VoiceMode from '$lib/components/VoiceMode.svelte';
	import MessageFeed from '$lib/components/MessageFeed.svelte';

	let { data } = $props();

	// ─────────────────────────────────────────────────────────────────────
	// State Declarations
	// ─────────────────────────────────────────────────────────────────────
	// `ChatMessage` (the client view-model row) now lives in $lib/types/chat-ui
	// so the voice controller can share it.
	let messages = $state<ChatMessage[]>(untrack(() => data.messages || []));
	let workspaces = $state(untrack(() => data.workspaces || []));
	// Threads + active-thread state + every CRUD action are owned by the
	// controller (PR E1). Page reads go through `threadsCtrl.*`; bindable
	// sidebar state uses controller getter/setter pairs.
	const threadsCtrl = createThreadsController({
		getInitialThreads: () => data.threads || [],
		getInitialActiveThread: () => data.activeThread || 'default',
		setMessages: (next) => {
			messages = next;
		},
		setSidebarOpen: (v) => {
			sidebarOpen = v;
		},
		pollMessages: (threadId) => pollMessages(threadId),
		loadTier: (threadId) => loadTier(threadId),
		syncUrlThread: (threadId) => {
			try {
				replaceState(resolve('/chat') + '?thread=' + encodeURIComponent(threadId), {});
			} catch {
				/* navigation failure shouldn't break the in-page switch */
			}
		}
	});
	const composerCtrl = createComposerStateController({
		getActiveThread: () => threadsCtrl.activeThread,
		getSelectedRepo: () => selectedRepo,
		focusComposer: () => textareaEl?.focus()
	});
	const textDraft = $derived(composerCtrl.textDraft);
	const attachments = $derived(composerCtrl.attachments);
	// Initial workspace from the loader — fork-aware (companion mode starts on
	// 'companion', wired mode on 'LogueOS-Console'). Never hard-code the wired
	// default here; that's how the model started identifying itself as Console.
	let selectedRepo = $state<string>(
		untrack(() => data.appIdentity?.defaultWorkspace || 'LogueOS-Console')
	);
	let currentTier = $state<Tier>('chat');
	// Operator's explicit tier override, separate from the classifier-driven
	// `currentTier`. We need this for chip display: when the operator picks
	// e.g. Local, the server keeps `current_tier='chat'` (classifier untouched)
	// but `operator_override='local'`. The chip should reflect what the
	// operator picked, not what the classifier thinks.
	let operatorOverride = $state<Tier | null>(null);
	let lastModelUsed = $state('');
	let sending = $state(false);

	let showModelOverrideModal = $state(false);

	// Workspace-context editor (task #22 — Projects-light borrow).
	let workspaceContextOpen = $state(false);
	let workspaceContextDraft = $state('');
	let workspaceContextSaving = $state(false);
	// CR (PR #140) — track whether the initial GET succeeded. If it failed
	// (network error, 5xx), the draft stays empty; without this gate, Save
	// would write `addendum=""` and clear the operator's stored context.
	let workspaceContextLoaded = $state(false);
	let workspaceContextLoadError = $state(false);
	const WORKSPACE_CONTEXT_MAX = 4000;
	let sidebarOpen = $state(false);
	let imageMode = $state(false);

	// Ephemeral worker-activity pill state.
	let activityPill = $state<{ worker: string; step: string; trace_id: string } | null>(null);
	let activityFadeTimer: ReturnType<typeof setTimeout> | null = null;

	// Active companion-dispatch SSE controllers, keyed by sully-* trace_id.
	// Plain (non-reactive) registry of SSE controllers, keyed by sully-* trace_id.
	// NOT $state: it's mutated from a template {@const} during render (below), and
	// mutating $state mid-render throws Svelte's state_unsafe_mutation. The bubble
	// stays live via the controller's OWN $state getters (rows/status/resultRef),
	// and the row re-renders when `messages` changes — so this map needn't react.
	const dispatchStreams: Record<string, ReturnType<typeof createDispatchStream>> = {};

	function ensureDispatchStream(traceId: string) {
		if (dispatchStreams[traceId]) return dispatchStreams[traceId];
		const ctrl = createDispatchStream(traceId);
		ctrl.start();
		dispatchStreams[traceId] = ctrl;
		return ctrl;
	}

	// Composer states
	let composerMode = $state<ComposerMode>('idle');

	// threadMenuOpenFor (and renamingFor / renameDraft / showArchived) live on
	// threadsCtrl now (PR E1) — the global popover handler reads
	// `threadsCtrl.threadMenuOpenFor` and writes via the controller's setter.

	// Close every open popover. Used by the global Escape + click-outside
	// handler below. Replaces the per-popover `fixed inset-0 z-40` backdrop
	// `<button>` pattern that was trapping clicks on other chrome — see audit
	// 2026-05-27 and [[reference_chat_app_competitive_borrows]] for the bug
	// shape.
	function closeAllPopovers() {
		showModelOverrideModal = false;
		threadsCtrl.threadMenuOpenFor = null;
	}

	// Global popover dismiss — keyboard Escape + click outside any popover
	// content closes everything open. Each popover content `<div>` carries
	// `data-popover` (clicks inside the open popover are left alone), each
	// opener `<button>` carries `data-popover-trigger`.
	//
	// Trigger clicks DO close all popovers via this handler; the trigger's
	// own onclick fires after (capture vs bubble) and re-opens just its own
	// popover. Net result: clicking one trigger while another popover is
	// open swaps the popovers in a single tap.
	$effect(() => {
		const anyOpen = showModelOverrideModal || threadsCtrl.threadMenuOpenFor !== null;
		if (!anyOpen) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') {
				e.preventDefault();
				closeAllPopovers();
			}
		}
		function onPointerDown(e: PointerEvent) {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			// Clicks INSIDE an open popover are left alone (let the popover's
			// own onclick fire — choose a model, switch repo, etc.).
			if (target.closest('[data-popover]')) return;
			// Clicks on a popover TRIGGER are also left alone — let the trigger's own
			// onclick toggle it. Otherwise this capture-phase handler closes it first,
			// then the trigger's onclick reads the already-reset state and re-opens it
			// (the "won't close when I tap the button" bug).
			if (target.closest('[data-popover-trigger]')) return;
			closeAllPopovers();
		}
		window.addEventListener('keydown', onKey);
		window.addEventListener('pointerdown', onPointerDown, true);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('pointerdown', onPointerDown, true);
		};
	});

	// Persistent <audio> element for TTS — bound in the template, read by the
	// voice controller via its getAudioEl port.
	let audioEl = $state<HTMLAudioElement | null>(null);

	// Voice / talkback state machine — extracted to its own rune module
	// ($lib/chat/voice.svelte.ts, cleanup ③ slice 3c). It owns `active`/`phase`
	// plus every device resource (MediaRecorder, AudioContext, ScriptProcessor,
	// WakeLock, SpeechRecognition) and reaches the page's reactive state ONLY
	// through this getter/setter port — keeping reactive ownership where the
	// template binds it. The template reads `voice.phase`; `composerMode` stays
	// page-owned (it spans idle/focused/talkback) and the controller
	// writes it through setComposerMode.
	const voice = createVoiceController({
		getActiveThread: () => threadsCtrl.activeThread,
		getSelectedRepo: () => selectedRepo,
		getMessages: () => messages,
		getAudioEl: () => audioEl,
		getComposerMode: () => composerMode,
		setComposerMode: (m) => (composerMode = m),
		focusComposer: () => textareaEl?.focus(),
		appendMessage: (m) => {
			messages = [...messages, m];
		},
		setCurrentTier: (t) => (currentTier = t),
		setUserAtBottom: (v) => (userAtBottom = v),
		pollMessages
	});

	// Realtime Voice Mode controller — the immersive local-GPU voice pipeline
	// (live STT partials → streaming companion reply → Chatterbox TTS → barge-in).
	// Distinct from the legacy in-composer `voice` Talkback loop above; entered
	// from the Composer's Voice button and rendered as a full-screen overlay.
	const rtVoice = createRealtimeVoiceController({
		getActiveThread: () => threadsCtrl.activeThread,
		pollMessages
	});

	// Element refs
	let feedContainer = $state<HTMLDivElement | null>(null);
	let scrollSentinel = $state<HTMLDivElement | null>(null);
	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let fileInputEl = $state<HTMLInputElement | null>(null);

	function scrollFeedToBottom(behavior: ScrollBehavior = 'smooth') {
		if (!feedContainer) return;
		feedContainer.scrollTo({ top: feedContainer.scrollHeight, behavior });
	}

	// SDK streaming + transport extracted to streaming.svelte.ts (PR E4).
	const streamingCtrl = createStreamingController({
		getActiveThread: () => threadsCtrl.activeThread,
		getSelectedRepo: () => selectedRepo,
		getProviderOverride: () => providerOverride,
		getModelOverride: () => modelOverride,
		getToolsKey: () => toolsKey,
		getMessages: () => messages,
		getUserAtBottom: () => userAtBottom,
		setMessages: (next) => {
			messages = next;
		},
		pollMessages: () => pollMessages(),
		scrollToBottom: (behavior) => scrollFeedToBottom(behavior)
	});
	const streamState = $derived(streamingCtrl.streamState);
	const sdkChat = $derived(streamingCtrl.sdkChat);
	// True while the current stream is running tool calls (e.g. web search). The
	// tool row shows the working monster, so we hide the plain thinking-dots
	// indicator to avoid two avatars at once.
	const hasActiveToolCalls = $derived(
		!!streamState &&
			sdkChat.messages.some((m) => (m.parts || []).some((p) => p.type?.startsWith('tool-')))
	);

	// Pending attachments — uploads stage here as removable chips above the
	// composer rather than getting injected as markdown into the textarea.
	// On send, each attachment's markdown link is appended to the outgoing
	// message body so the server-side rendering stays unchanged. A `text`
	// field on an Attachment marks it as a paste-to-attachment chip — the
	// content lives in memory, no upload, folded into the message body as
	// a fenced code block on send. See [[reference_chat_app_competitive_borrows]]
	// for the ChatGPT-borrow rationale (long pastes auto-convert to keep
	// composer clean + prevent context-window blowout).

	// Canvas (Artifacts) side panel — PR A of #20 epic. View-only for now;
	// multi-tab + persistence land in follow-up PRs.
	let canvasArtifact = $state<{ code: string; language: string } | null>(null);
	function openCanvas(code: string, language: string) {
		canvasArtifact = { code, language };
	}
	function closeCanvas() {
		canvasArtifact = null;
	}

	// Scroll state
	let userAtBottom = $state(true);
	let unseenCount = $state(0);

	// ─────────────────────────────────────────────────────────────────────
	// Derived properties
	// ─────────────────────────────────────────────────────────────────────
	const selectedWorkspace = $derived(workspaces.find((w) => w.name === selectedRepo));
	const tierEmoji = $derived(
		currentTier === 'planning'
			? '⚖️'
			: currentTier === 'deep'
				? '🧠'
				: currentTier === 'local'
					? '🔧'
					: '🪶'
	);

	// Composer textarea auto-grow $effect moved into <Composer /> as part of
	// Task #7 PR 4 — the effect's deps are local to the component (`textDraft`
	// + `textareaEl`), so it travels cleanly. The parent's draft-persist
	// effect (further down) still reads `textDraft` via the bindable.

	// ─────────────────────────────────────────────────────────────────────
	// Network & Data Actions
	// ─────────────────────────────────────────────────────────────────────
	async function loadTier(threadId: string) {
		try {
			const r = await fetch(resolve(`/api/chat/tier?thread_id=${encodeURIComponent(threadId)}`));
			if (r.ok) {
				const b = await r.json();
				if (b.current_tier) currentTier = b.current_tier as Tier;
				operatorOverride = (b.operator_override ?? null) as Tier | null;
				providerOverride = (b.provider_override ?? null) as ProviderPref;
				lastModelUsed = b.last_model_used || '';
			}
		} catch {
			/* keep last known */
		}
	}

	let providerOverride = $state<ProviderPref>(null);
	// Explicit model id pinned by a picker choice that carries one (e.g. an
	// Ollama Cloud model). Sent as body.model; session-scoped (not persisted).
	let modelOverride = $state<string | null>(null);
	// Per-device unlock code for the sensitive machine-read + web tools. Set via
	// `/unlock <code>`, stored in localStorage, sent as a header so the tools
	// work over the normal public link only on devices the operator unlocked.
	let toolsKey = $state<string>('');

	// Chip-display tier: prefer the operator's explicit override over the
	// classifier-driven `currentTier`. Server keeps current_tier untouched
	// when an override is set (override doesn't retrain the classifier),
	// so without this we'd display the classifier's tier even though the
	// operator manually chose a different one.
	const effectiveTier = $derived(operatorOverride ?? currentTier);
	const selectedModelChoice = $derived(
		modelOverride
			? (MODEL_CHOICES.find((c) => c.model === modelOverride) ?? MODEL_CHOICES[0])
			: (MODEL_CHOICES.find(
					(c) =>
						(c.tier ?? null) ===
							(effectiveTier === 'chat' && !providerOverride && !operatorOverride
								? null
								: effectiveTier) &&
						c.provider === providerOverride &&
						!c.model
				) ?? MODEL_CHOICES[0])
	);

	async function openWorkspaceContextEditor() {
		closeAllPopovers();
		workspaceContextOpen = true;
		workspaceContextDraft = '';
		workspaceContextLoaded = false;
		workspaceContextLoadError = false;
		try {
			const r = await fetch(resolve('/api/chat/workspaces/[name]/context', { name: selectedRepo }));
			if (r.ok) {
				const body = (await r.json()) as { addendum?: string };
				workspaceContextDraft = body.addendum ?? '';
				workspaceContextLoaded = true;
			} else {
				workspaceContextLoadError = true;
			}
		} catch {
			workspaceContextLoadError = true;
		}
	}

	async function retryLoadWorkspaceContext() {
		workspaceContextLoadError = false;
		await openWorkspaceContextEditor();
	}

	async function saveWorkspaceContext() {
		if (workspaceContextSaving) return;
		// CR (PR #140) — refuse to save if the initial GET failed. Without
		// this, the empty draft would clobber the operator's persisted addendum.
		if (!workspaceContextLoaded) {
			toasts.add('Reload context before saving — initial load failed', 'error');
			return;
		}
		workspaceContextSaving = true;
		try {
			const r = await fetch(
				resolve('/api/chat/workspaces/[name]/context', { name: selectedRepo }),
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ addendum: workspaceContextDraft })
				}
			);
			if (r.ok) {
				toasts.add(`Context saved for ${selectedRepo}`, 'success');
				workspaceContextOpen = false;
			} else {
				toasts.add('Save failed', 'error');
			}
		} catch {
			toasts.add('Save failed — network error', 'error');
		} finally {
			workspaceContextSaving = false;
		}
	}

	async function setModelChoice(choice: ModelChoice) {
		showModelOverrideModal = false;
		// Pin an explicit model id when the choice carries one (Ollama Cloud
		// models); clear it otherwise so tier→model resolution applies.
		modelOverride = choice.model ?? null;
		try {
			const resp = await fetch(resolve('/api/chat/tier'), {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					thread_id: threadsCtrl.activeThread,
					tier: choice.tier,
					provider: choice.provider
				})
			});
			if (resp.ok) {
				const body = await resp.json();
				if (body.current_tier) currentTier = body.current_tier as Tier;
				operatorOverride = (body.operator_override ?? null) as Tier | null;
				providerOverride = (body.provider_override ?? null) as ProviderPref;
				await loadTier(threadsCtrl.activeThread);
				toasts.add(`Model set to ${choice.label}`, 'success');
			}
		} catch {
			toasts.add('Failed to update model preference', 'error');
		}
	}

	async function pollMessages(forThread?: string) {
		// Capture the thread the caller intended at the moment of the request.
		// Without this guard a slow in-flight poll for the previous thread can
		// land after switchThread() has flipped activeThread and clobber the
		// new thread's (empty) messages with the previous thread's content —
		// exact symptom the operator reported: "old thread shows up instead
		// of a clean slate."
		const requestedThread = forThread ?? threadsCtrl.activeThread;
		// Skip the reconciliation while an SDK stream is in flight — the
		// placeholder bubble's partial text would get wiped by the DB-driven
		// replacement (which doesn't yet contain the streaming reply). The
		// stream's own finally{} block calls pollMessages once after the
		// stream completes, so the canonical row lands then. Audit 2026-05-27
		// caught this race live as "operator's send disappears from the UI".
		// Only suppress when the in-flight stream is for THIS same thread.
		// Switching threads mid-stream must allow the new thread's poll to land.
		if (streamState && streamState.threadId === requestedThread) return;
		try {
			const r = await fetch(
				resolve('/api/chat') + `?thread=${encodeURIComponent(requestedThread)}`
			);
			if (!r.ok) return;
			// Drop the response if the operator switched threads while the
			// fetch was in flight. The 3s poll will re-fire with the new thread.
			if (requestedThread !== threadsCtrl.activeThread) return;
			const b = await r.json();
			const newMessages: ChatMessage[] = b.messages || [];
			if (
				newMessages.length !== messages.length ||
				JSON.stringify(newMessages) !== JSON.stringify(messages)
			) {
				if (!userAtBottom) {
					const added = newMessages.length - messages.length;
					if (added > 0) unseenCount += added;
				}
				messages = newMessages;
				if (userAtBottom) {
					queueMicrotask(() => scrollFeedToBottom('smooth'));
				}
			}
		} catch {
			/* offline */
		}
	}

	async function pollActivity() {
		try {
			const r = await fetch(resolve('/api/chat/activity?limit=8'));
			if (!r.ok) return;
			const b = await r.json();
			const rows = (b.activity || []) as Array<{
				trace_id: string;
				action: string;
				target: string | null;
				timestamp: string;
			}>;
			const cutoff = Date.now() - 5 * 60 * 1000;
			let live: typeof activityPill = null;
			for (const row of rows) {
				if ((parseDbTimestamp(row.timestamp)?.getTime() ?? cutoff) < cutoff) continue;
				if (row.action === 'completed' || row.action === 'failed') continue;
				const worker = row.trace_id.startsWith('agy-') ? 'AGY' : 'CC';
				const step = row.target ? `${row.action} '${row.target}'` : row.action;
				live = { worker, step, trace_id: row.trace_id };
				break;
			}
			if (live) {
				activityPill = live;
				if (activityFadeTimer) clearTimeout(activityFadeTimer);
				activityFadeTimer = setTimeout(() => {
					if (activityPill?.trace_id === live!.trace_id) activityPill = null;
				}, 60_000);
			} else if (activityPill) {
				if (activityFadeTimer) clearTimeout(activityFadeTimer);
				activityFadeTimer = setTimeout(() => {
					activityPill = null;
				}, 3000);
			}
		} catch {
			/* silent */
		}
	}

	// ─────────────────────────────────────────────────────────────────────
	// Send text message
	// ─────────────────────────────────────────────────────────────────────
	async function sendMessage() {
		// Slash command takes precedence — if the draft is /<known-command>
		// we run it locally instead of dispatching to /api/chat.
		if (await runSlashFromDraft()) return;

		const text = textDraft.trim();
		// Allow sending an attachment-only message (no text body), but require
		// at least one of the two so we don't post empty rows.
		if (!text && attachments.length === 0) return;
		if (sending) return;
		if (attachments.some((a) => a.uploading)) {
			toasts.add('Wait for image upload to finish', 'info');
			return;
		}
		voice.unlockAudio();
		sending = true;

		const isGenImage = imageMode;
		imageMode = false; // toggle off image mode immediately on send

		// Fold staged attachments into the outgoing message body as markdown
		// image links. The server is unchanged — the message field is a string;
		// the chat renderer already handles ![alt](url) markdown. Chips just
		// stage them visually until send.
		const attachmentMd = attachments
			.map((a) => (a.text ? `\n\`\`\`\n${a.text}\n\`\`\`\n` : `![${a.filename}](${a.url})`))
			.join('\n');
		const messageBody = [text, attachmentMd].filter(Boolean).join('\n\n');

		const optimistic: ChatMessage = {
			id: Date.now(),
			sender: 'operator',
			message: messageBody,
			timestamp: new Date().toISOString()
		};
		messages = [...messages, optimistic];
		composerCtrl.textDraft = '';
		composerCtrl.attachments = [];
		queueMicrotask(() => scrollFeedToBottom('smooth'));

		// Routing decision: if the message looks like an explicit worker
		// dispatch or it's an image-gen request, use the non-streaming
		// /api/chat endpoint. Otherwise stream tokens via the SDK (which
		// hits /api/chat/sdk-stream — see runStreamingSend below).
		const lower = messageBody.toLowerCase();
		const isDispatch = lower.includes('@cc') || lower.includes('@agy') || lower.includes('@gemini');
		const useStream = !isDispatch && !isGenImage;

		try {
			if (useStream) {
				await streamingCtrl.run(messageBody);
			} else {
				const r = await fetch(resolve('/api/chat'), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						message: messageBody,
						thread: threadsCtrl.activeThread,
						target_repo: selectedRepo,
						image: isGenImage || undefined
					})
				});
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				await pollMessages();
			}
		} catch (e) {
			toasts.add(`Send failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error');
			composerCtrl.textDraft = text; // restore
		} finally {
			sending = false;
		}
	}

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void sendMessage();
		}
	}

	// Per-message actions (copy / regenerate / read-aloud) extracted to their own
	// controller ($lib/chat/message-actions.svelte.ts). It owns the button-state
	// sets (copiedIds / regeneratingIds / speakingId / speakLoadingId) + the
	// read-aloud audio resources; `messages` + `sending` stay page-owned and are
	// reached through the deps port. Regenerate re-streams via streamingCtrl.run.
	const messageActions = createMessageActionsController({
		getMessages: () => messages,
		setMessages: (next) => {
			messages = next;
		},
		getSending: () => sending,
		setSending: (v) => (sending = v),
		unlockAudio: () => voice.unlockAudio(),
		runStream: (messageBody) => streamingCtrl.run(messageBody)
	});

	// Streaming send via @ai-sdk/svelte's Chat against /api/chat/sdk-stream.
	// Inserts a placeholder assistant bubble (sender derived from active
	// provider), the SDK transport handles the token stream, and the server's
	// onFinish callback persists the canonical row. pollMessages() at the
	// end reconciles the placeholder against the canonical numeric-id row.
	// Mirror SDK chat's streaming text into the placeholder bubble so the rest
	// of the chat surface keeps a single render path off `messages`. While a
	// stream is active, the last assistant message in chat.messages carries

	// ─────────────────────────────────────────────────────────────────────
	// Paperclip Upload Wiring
	// ─────────────────────────────────────────────────────────────────────
	function triggerUpload() {
		fileInputEl?.click();
	}

	// humanSize moved into <Composer /> with the staged-attachments chip row
	// in Task #7 PR 4.

	// ─────────────────────────────────────────────────────────────────────
	// Slash commands. Operator types `/` at the start of the composer →
	// autocomplete popup lists matching commands. Submit (Enter / Send /
	// click on row) runs the command's handler instead of sending the
	// literal text to the LLM.
	// ─────────────────────────────────────────────────────────────────────

	function addLocalSystemMessage(text: string) {
		messages = [
			...messages,
			{
				id: Date.now(),
				sender: 'system',
				message: text,
				timestamp: new Date().toISOString()
			}
		];
	}

	const slashCtrl = createSlashCommandsController({
		getActiveThread: () => threadsCtrl.activeThread,
		getMessages: () => messages,
		setTextDraft: (s) => {
			composerCtrl.textDraft = s;
		},
		clearAttachments: () => {
			composerCtrl.attachments = [];
		},
		focusComposer: () => textareaEl?.focus(),
		appendSystemMessage: addLocalSystemMessage,
		pollMessages: () => pollMessages(),
		setToolsKey: (key) => {
			toolsKey = key;
		},
		regenerateReply: (m) => messageActions.regenerateReply(m),
		createThread: async (rest) => {
			// /new wraps the threads controller's slug + switch flow.
			const baseSlug = threadsCtrl.slugifyThreadName(rest);
			if (!baseSlug || baseSlug === 'thread') {
				toasts.add('Thread name required: /new my-feature', 'error');
				return;
			}
			const slug = await threadsCtrl.findUniqueSlug(baseSlug);
			const title = slug === baseSlug ? rest.trim() || slug : slug;
			if (slug !== baseSlug) {
				toasts.add(`"${baseSlug}" was taken — created "${slug}" for a clean slate.`, 'info');
			}
			threadsCtrl.threads = [
				{
					thread_id: slug,
					title,
					archived: false,
					pinned: false,
					message_count: 0,
					latest_ts: ''
				},
				...threadsCtrl.threads
			];
			await threadsCtrl.switchThread(slug);
			toasts.add(`Switched to thread "${slug}"`, 'success');
		}
	});

	const slashQuery = $derived(
		textDraft.startsWith('/') ? textDraft.slice(1).split(/\s/)[0].toLowerCase() : null
	);
	const slashMatches = $derived(
		slashQuery === null ? [] : slashCtrl.commands.filter((c) => c.key.startsWith(slashQuery))
	);
	const slashMode = $derived(
		textDraft.startsWith('/') && !textDraft.includes('\n') && slashMatches.length > 0
	);

	async function runSlashFromDraft(): Promise<boolean> {
		return await slashCtrl.runFromDraft(textDraft);
	}
	async function pickSlash(cmd: SlashCmd) {
		await slashCtrl.pick(cmd, textDraft);
	}

	// ─────────────────────────────────────────────────────────────────────
	// Lifecycle
	// ─────────────────────────────────────────────────────────────────────
	let pollTimer: ReturnType<typeof setInterval>;
	let activityTimer: ReturnType<typeof setInterval>;
	let sentinelObs: IntersectionObserver | null = null;

	onMount(() => {
		void loadTier(threadsCtrl.activeThread);
		// Restore this device's tools-unlock code (set previously via /unlock).
		try {
			toolsKey = localStorage.getItem('companion-tools-key') ?? '';
		} catch {
			/* ignore */
		}
		if (feedContainer && scrollSentinel) {
			sentinelObs = new IntersectionObserver(
				(entries) => {
					const ent = entries[0];
					if (ent?.isIntersecting) {
						userAtBottom = true;
						unseenCount = 0;
					} else {
						userAtBottom = false;
					}
				},
				{ root: feedContainer, threshold: 0 }
			);
			sentinelObs.observe(scrollSentinel);
		}
		queueMicrotask(() => scrollFeedToBottom('auto'));
		pollTimer = setInterval(pollMessages, 3000);
		// Companion dispatch streams live activity over SSE (per-trace). The
		// legacy 5s pollActivity loop only runs when SSE dispatch is NOT active.
		if (!data.companionDispatchEnabled) {
			activityTimer = setInterval(pollActivity, 5000);
		}
	});

	onDestroy(() => {
		clearInterval(pollTimer);
		if (activityTimer) clearInterval(activityTimer);
		for (const ctrl of Object.values(dispatchStreams)) ctrl.destroy();
		sentinelObs?.disconnect();
		if (activityFadeTimer) clearTimeout(activityFadeTimer);
		threadsCtrl.destroy?.();
		composerCtrl.destroy?.();
		void voice.destroy();
		void rtVoice.destroy();
		messageActions.destroy();
	});

	// Utilities
	function fmtTime(iso: string): string {
		try {
			const d = parseDbTimestamp(iso);
			return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
		} catch {
			return '';
		}
	}
</script>

<svelte:head>
	<title>Companion</title>
</svelte:head>

<!-- Persistent audio element for ElevenLabs speech -->
<audio bind:this={audioEl} class="hidden" aria-hidden="true"></audio>

<!-- Realtime Voice Mode full-screen overlay (renders only when open) -->
<VoiceMode voice={rtVoice} />
<input
	type="file"
	accept="image/*"
	bind:this={fileInputEl}
	class="hidden"
	onchange={composerCtrl.handleUpload}
/>

<div
	class="relative flex h-[100dvh] w-full overflow-hidden font-sans text-foreground"
	ondragenter={composerCtrl.handleDragEnter}
	ondragover={composerCtrl.handleDragOver}
	ondragleave={composerCtrl.handleDragLeave}
	ondrop={composerCtrl.handleDrop}
	role="region"
	aria-label="Chat surface (drop images to attach)"
>
	<!-- Drag-and-drop overlay now lives inside <Composer /> below — drag
	     handlers stay on this outer wrapper so the operator can drop
	     anywhere on the chat surface; the overlay renders conditional on
	     `isDragging`, which is bindable into the Composer. -->
	<!-- Radial Gradient Atmosphere Background -->
	<div
		class="pointer-events-none absolute inset-0 -z-0"
		style="background: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(168, 85, 247, 0.07), transparent 60%), radial-gradient(ellipse 60% 50% at 100% 100%, rgba(244, 114, 182, 0.04), transparent 50%);"
	></div>

	<!-- ═════════════════════════════════════════════════════════════════
	     COLLAPSIBLE THREADS SIDEBAR (PR 7 redone for Conversational OS)
	     ═════════════════════════════════════════════════════════════════ -->
	<ThreadsSidebar
		threads={threadsCtrl.threads}
		activeThread={threadsCtrl.activeThread}
		bind:sidebarOpen
		bind:showArchived={threadsCtrl.showArchived}
		bind:renamingFor={threadsCtrl.renamingFor}
		bind:renameDraft={threadsCtrl.renameDraft}
		bind:threadMenuOpenFor={threadsCtrl.threadMenuOpenFor}
		onswitchThread={(id) => void threadsCtrl.switchThread(id)}
		onnewThread={() => void threadsCtrl.newThread()}
		oncloseSidebar={() => (sidebarOpen = false)}
		oncommitRename={(id) => void threadsCtrl.commitRename(id)}
		oncancelRename={threadsCtrl.cancelRename}
		ontogglePin={(t) => void threadsCtrl.togglePin(t)}
		ontoggleArchive={(t) => void threadsCtrl.toggleArchive(t)}
		ondeleteThread={(t) => void threadsCtrl.deleteThreadById(t)}
		onopenRename={threadsCtrl.openRename}
		onclearAll={() => void threadsCtrl.clearAllSessions()}
		coreLabel={data.appIdentity?.coreLabel ?? 'LogueOS-Console'}
	/>

	<!-- ═════════════════════════════════════════════════════════════════
	     MAIN CONVERSATIONAL CANVAS
	     ═════════════════════════════════════════════════════════════════ -->
	<main class="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden select-text">
		<!-- ═════════════════════════════════════════════════════════════════
		     QUIET HEADER
		     ═════════════════════════════════════════════════════════════════ -->
		<ChatHeader
			{tierEmoji}
			{lastModelUsed}
			{selectedModelChoice}
			{MODEL_CHOICES}
			bind:showModelOverrideModal
			ontoggleSidebar={() => (sidebarOpen = !sidebarOpen)}
			onsetModelChoice={(choice) => void setModelChoice(choice)}
			onopenWorkspaceContext={() => void openWorkspaceContextEditor()}
			oncloseAllPopovers={closeAllPopovers}
		/>

		<!-- ═════════════════════════════════════════════════════════════════
		     EPHEMERAL ACTIVITY PILL
		     ═════════════════════════════════════════════════════════════════ -->
		{#if activityPill}
			<div
				class="relative z-10 mx-auto shrink-0 px-4 pb-1 select-none"
				style="animation: fade-in 0.3s ease-out;"
			>
				<div
					class="inline-flex items-center gap-2 rounded-full border border-cyan-400/25 bg-cyan-950/20 px-3.5 py-1.5 backdrop-blur-md"
					style="box-shadow: 0 0 16px rgba(34, 211, 238, 0.1);"
				>
					<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400"></span>
					<span class="font-sans text-[11px] tracking-wide text-cyan-400">
						⚡ {activityPill.worker}: {activityPill.step}
					</span>
					<a
						href={resolve('/api/chat/activity')}
						class="ml-1.5 font-sans text-[10px] text-cyan-300/60 transition-colors hover:text-cyan-300"
					>
						[View JSON]
					</a>
				</div>
			</div>
		{/if}

		<!-- ═════════════════════════════════════════════════════════════════
		     CINEMATIC MESSAGE FEED
		     ═════════════════════════════════════════════════════════════════ -->
		<div
			bind:this={feedContainer}
			class="relative z-10 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-4 py-4 md:px-6"
		>
			<MessageFeed
				{messages}
				{streamState}
				{sdkChat}
				{hasActiveToolCalls}
				appIdentity={data.appIdentity}
				copiedIds={messageActions.copiedIds}
				regeneratingIds={messageActions.regeneratingIds}
				speakingId={messageActions.speakingId}
				speakLoadingId={messageActions.speakLoadingId}
				{sending}
				bind:scrollSentinel
				oncopy={(m) => void messageActions.copyMessage(m)}
				onregenerate={(m) => void messageActions.regenerateReply(m)}
				onspeak={(m) => void messageActions.speakMessage(m)}
				{openCanvas}
				{ensureDispatchStream}
				{fmtTime}
				{parseDbTimestamp}
			/>
		</div>

		{#if unseenCount > 0 && !userAtBottom}
			<button
				type="button"
				onclick={() => {
					userAtBottom = true;
					unseenCount = 0;
					scrollFeedToBottom('smooth');
				}}
				class="absolute right-1/2 bottom-24 z-20 flex translate-x-1/2 items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3.5 py-1.5 font-sans text-[11px] text-cyan-300 backdrop-blur-md transition-all select-none hover:scale-105 active:scale-95"
				style="box-shadow: 0 0 16px rgba(34, 211, 238, 0.2);"
			>
				{unseenCount} new messages ↓
			</button>
		{/if}

		<!-- ═════════════════════════════════════════════════════════════════
		     HERO COMPOSER PILL — extracted to <Composer /> (Task #7 PR 4).
		     Drag handlers stay on the outer wrapper (composerCtrl.handleDragEnter/Over/
		     Leave/Drop above); Composer renders the drop overlay conditional
		     on `isDragging`.
		     ═════════════════════════════════════════════════════════════════ -->
		<Composer
			bind:textDraft={() => composerCtrl.textDraft, (v) => (composerCtrl.textDraft = v)}
			bind:imageMode
			bind:isDragging={() => composerCtrl.isDragging, (v) => (composerCtrl.isDragging = v)}
			bind:textareaEl
			attachments={composerCtrl.attachments}
			{composerMode}
			{sending}
			talkbackPhase={voice.phase}
			{slashMode}
			{slashMatches}
			onsend={() => void sendMessage()}
			onpaste={composerCtrl.handlePaste}
			onkey={handleKey}
			onfocus={() => composerMode === 'idle' && (composerMode = 'focused')}
			onblur={() => composerMode === 'focused' && (composerMode = 'idle')}
			ontriggerUpload={triggerUpload}
			ontoggleTalkback={() => void voice.toggleTalkback()}
			onstopTalkback={() => void voice.stopTalkback()}
			onvoiceMode={() => void rtVoice.enter()}
			onpickSlash={(cmd) => void pickSlash(cmd)}
			onremoveAttachment={composerCtrl.removeAttachment}
		/>
	</main>
</div>

<WorkspaceContextModal
	bind:open={workspaceContextOpen}
	bind:draft={workspaceContextDraft}
	saving={workspaceContextSaving}
	loaded={workspaceContextLoaded}
	loadError={workspaceContextLoadError}
	{selectedRepo}
	{selectedWorkspace}
	onsave={saveWorkspaceContext}
	onretry={retryLoadWorkspaceContext}
	onclose={() => (workspaceContextOpen = false)}
/>

{#if canvasArtifact}
	<Canvas code={canvasArtifact.code} language={canvasArtifact.language} onclose={closeCanvas} />
{/if}

<style>
	@keyframes fade-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
