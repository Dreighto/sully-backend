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
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
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
	import { createVoiceModeMachine } from '$lib/chat/voice-mode.svelte';
	import { createMessageActionsController } from '$lib/chat/message-actions.svelte';
	import { replaceState } from '$app/navigation';
	import { toasts } from '$lib/utils/toasts';
	import { saveScrollPos, restoreScrollPos, clearScrollPos } from '$lib/utils/scroll-restore';
	import Canvas from '$lib/components/Canvas.svelte';
	import WorkspaceContextModal from '$lib/components/WorkspaceContextModal.svelte';
	import ThreadsSidebar from '$lib/components/ThreadsSidebar.svelte';
	import ChatHeader from '$lib/components/ChatHeader.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import { spawnSurface, setStatus, type WorkSurfaceDockMode } from '$lib/work-surface';
	import { buildInitialTaskFromProposal } from '$lib/work-surface/chatBridge.svelte';
	import type { SurfaceStatus } from '$lib/types/workSurface';
	import VoiceMode from '$lib/components/VoiceMode.svelte';
	import MessageFeed from '$lib/components/MessageFeed.svelte';
	import ImageLightbox from '$lib/components/ImageLightbox.svelte';

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
			// Save scroll pos when clearing messages (thread switch). An empty
			// `next` is the switchThread signal — save the current position so
			// we can restore it when the operator comes back to this thread.
			if (next.length === 0 && feedContainer && messages.length > 0) {
				saveScrollPos(threadsCtrl.activeThread, feedContainer.scrollTop);
			}
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
		},
		persistActiveThread: (threadId) => {
			// Fire-and-forget server persist so a background/close right after a
			// switch resumes THIS thread on reopen (restore order step 2). Errors are
			// non-fatal — the next real turn re-persists via setActiveThread anyway.
			void fetch(resolve('/api/chat/state'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ thread: threadId })
			}).catch(() => {});
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
	// Lightbox state — set from Markdown's onimagepreview click delegate.
	// Cleared by ImageLightbox's onclick (scrim or X). When non-null the
	// overlay is mounted via a host element that listens for the close event.
	let lightboxImage = $state<{ src: string; alt: string } | null>(null);

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

	// Work-surface spawn registry: trace_id → surface_id. Phase 2 wire-up so the
	// pill appears on dispatch Run / @cc direct, and settles on stream terminal.
	// $state so mutations from ensureSurfaceForTrace (called via
	// ensureDispatchStream's onActive async callback) propagate to
	// MessageFeed's flag-on conditional. Caught during Phase 3 iOS verify —
	// plain-object mutation didn't re-evaluate the @const block.
	const traceToSurface = $state<Record<string, string>>({});

	// LOS-192 part 1: the old work-surface chrome (WorkSurfaceComposerChrome
	// pill + dock above the composer) and the flag-gated DispatchCard /
	// HybridSurfaceMount feed paths are RETIRED from the mount tree — the feed
	// renders the collapsed WorkerPill for dispatch rows instead. The legacy
	// module is quarantined on disk (build-then-delete discipline); the
	// surfaceStore spawn plumbing below stays live for the part-2 run sheet.

	/** Spawn a work-surface for `traceId` if one doesn't exist yet. Looks up the
	 *  dispatch row in `messages` and the operator request that preceded it to
	 *  build the initial task title. Idempotent.
	 *  @param msgOverride pre-known dispatch row (avoids the lookup in confirmProposal). */
	function ensureSurfaceForTrace(traceId: string, msgOverride?: ChatMessage): string | null {
		if (traceToSurface[traceId]) return traceToSurface[traceId];
		const dispatchRow = msgOverride ?? messages.find((x) => x.trace_id === traceId);
		if (!dispatchRow) return null;
		const i = messages.findIndex((x) => x.id === dispatchRow.id);
		const prior =
			i > 0 ? [...messages.slice(0, i)].reverse().find((x) => x.sender === 'operator') : null;
		const surfaceId = spawnSurface(
			String(dispatchRow.id),
			buildInitialTaskFromProposal({
				traceId,
				threadId: threadsCtrl.activeThread,
				requestText: prior?.message,
				proposalText: dispatchRow.message
			})
		);
		traceToSurface[traceId] = surfaceId;
		return surfaceId;
	}

	function ensureDispatchStream(traceId: string) {
		if (dispatchStreams[traceId]) return dispatchStreams[traceId];
		const ctrl = createDispatchStream(traceId, {
			onActive: () => {
				// Auto-spawn the pill for direct dispatches (@cc/@agy/@gemini) that
				// don't go through confirmProposal. Skipped for historic terminal
				// jobs (onActive only fires when the stream confirms live state).
				ensureSurfaceForTrace(traceId);
			},
			onTerminal: (streamStatus) => {
				const surfaceId = traceToSurface[traceId];
				if (!surfaceId) return;
				const next: SurfaceStatus =
					streamStatus === 'failed' || streamStatus === 'error' ? 'failed' : 'done';
				setStatus(surfaceId, next);
			}
		});
		// SSR runs MessageFeed's template {@const ctrl = ensureDispatchStream(...)},
		// but ctrl.start() bails on !browser. If we cached that SSR controller,
		// hydration would short-circuit on the cache hit and never call start()
		// on the client → SSE never opens, onActive never fires, no pill. Only
		// cache + start on the browser side so hydration creates a fresh, started
		// controller. (Diagnosed live 2026-06-07: prod showed dispatch chip but
		// no pill while dev :5180 worked.)
		if (browser) {
			ctrl.start();
			dispatchStreams[traceId] = ctrl;
		}
		return ctrl;
	}

	// Composer states
	let composerMode = $state<ComposerMode>('idle');

	// Work surface: badge (pill) → inline (card in chat) → sheet (full detail).
	let dockMode = $state<WorkSurfaceDockMode>('badge');
	let dockOpenSurfaceId = $state<string | null>(null);
	let dockSheetReturnMode = $state<WorkSurfaceDockMode>('badge');

	/** Open the work-surface card for `traceId` as an expanded sheet. Used by the
	 *  notification deep-link (PR-0c): tap a "task done" push → land in the thread
	 *  → focus that task's card. Idempotent + safe to no-op (returns quietly if the
	 *  dispatch row for this trace isn't in the loaded thread, e.g. it was deleted). */
	function focusTraceCard(traceId: string) {
		const t = (traceId || '').trim();
		if (!t) return;
		const surfaceId = ensureSurfaceForTrace(t);
		if (!surfaceId) return;
		dockOpenSurfaceId = surfaceId;
		dockSheetReturnMode = 'badge';
		dockMode = 'sheet';
	}

	/** Apply a notification deep-link URL: switch to its `thread` (if different)
	 *  then focus its `trace_id` task card. Used for the WARM path (app already
	 *  open) — the service worker postMessages the URL on notificationclick. The
	 *  COLD-START path is handled in onMount (the thread is already resolved
	 *  server-side; we just focus the trace). */
	async function handleDeepLink(rawUrl: string) {
		let parsed: URL;
		try {
			parsed = new URL(rawUrl, window.location.origin);
		} catch {
			return;
		}
		const thread = parsed.searchParams.get('thread');
		const trace = parsed.searchParams.get('trace_id');
		if (thread && thread !== threadsCtrl.activeThread) {
			await threadsCtrl.switchThread(thread);
		}
		if (trace) focusTraceCard(trace);
	}

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
		pollMessages,
		// Surface exclusion (T1b): Talkback refuses to arm while the full-voice
		// overlay owns the screen. Reads rtVoice (declared below) lazily — only
		// invoked on a user toggle, long after init, so the forward ref is safe.
		isFullVoiceActive: () => rtVoice.open
	});

	// Realtime Voice Mode controller — the immersive local-GPU voice pipeline
	// (live STT partials → streaming companion reply → Chatterbox TTS → barge-in).
	// Distinct from the legacy in-composer `voice` Talkback loop above; entered
	// from the Composer's Voice button and rendered as a full-screen overlay.
	const rtVoice = createRealtimeVoiceController({
		getActiveThread: () => threadsCtrl.activeThread,
		pollMessages
	});

	// Voice SURFACE state machine (LOS-176 / T1b) — the single coordinator for
	// which voice surface owns the screen. Enforces Talkback ⊻ full-voice mutual
	// exclusion and decides whether the composer is MOUNTED (it is unmounted in
	// full voice, not hidden). Surface-level only: it never touches either
	// controller's transport. The template drives the voice-mode + talkback
	// toggles through THIS, not the controllers directly, so exclusion is
	// enforced in one place.
	const voiceMode = createVoiceModeMachine({
		getVoicePhase: () => rtVoice.phase,
		isFullVoiceOpen: () => rtVoice.open,
		isTalkbackActive: () => voice.active,
		openFullVoice: () => rtVoice.enter(),
		closeFullVoice: () => rtVoice.exit(),
		toggleTalkback: () => voice.toggleTalkback(),
		stopTalkback: (reason) => voice.stopTalkback(reason)
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

	// Auto-title wiring: when a stream just finished on a thread that still
	// looks default ('New thread' or slug-fallback), POST to the auto-title
	// endpoint and patch the sidebar row in place. The endpoint is idempotent
	// (server-side gate on meta.title === 'New thread') and skips threads with
	// too few messages, so we fire optimistically on every stream-completion
	// edge. Best-effort — failures are silent, never block the UI.
	let _prevStreamState: typeof streamState = null;
	$effect(() => {
		const cur = streamState;
		const prev = _prevStreamState;
		_prevStreamState = cur;
		// Edge: was streaming, now finished. Capture the threadId from PREV so
		// a mid-stream thread-switch still routes the auto-title to the
		// originating thread.
		if (prev !== null && cur === null) {
			const threadId = prev.threadId;
			untrack(() => {
				void threadsCtrl.maybeAutoTitleAfterReply(threadId);
			});
		}
	});
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

	// Pattern-match a model id string back to its provider. Used when in Auto
	// mode to surface the brand mark of whatever the server actually picked on
	// the last turn — `lastModelUsed` carries that resolved id.
	function inferProviderFromModelId(id: string): ProviderPref {
		if (!id) return null;
		if (/claude|opus|sonnet|haiku/i.test(id)) return 'anthropic';
		if (/gemini/i.test(id)) return 'gemini';
		if (/companion|qwen|llama|hermes|gpt-oss|local/i.test(id)) return 'local';
		return null;
	}

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

	// Provider the chip's brand icon should reflect:
	//   - explicit picker choice → that choice's provider
	//   - Auto → whatever Auto last resolved to (so the chip shows the actual
	//     brand Sully just used). Null only before the first resolution.
	const pickerProvider = $derived<ProviderPref>(
		selectedModelChoice.id === 'auto'
			? inferProviderFromModelId(lastModelUsed)
			: selectedModelChoice.provider
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
		// Hold the sheet open ~180ms so the operator sees the row's brand-pink
		// highlight + checkmark settle on the new selection before the sheet
		// slides away — replaces the previous toast confirmation, which the
		// operator flagged as noisy ("the toast needs to go"). The chip's text
		// updates instantly off `modelOverride` / `operatorOverride`, so the
		// sheet-close + chip-text-change reads as one continuous gesture.
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
			}
		} catch {
			toasts.add('Failed to update model preference', 'error');
		} finally {
			// Brief settle delay then close. 180ms = ~1 perceptual beat, enough
			// to register "yes, that one" without lingering.
			setTimeout(() => {
				showModelOverrideModal = false;
			}, 180);
		}
	}

	// Ask-before-dispatch tap-to-confirm. The buttons on a proposal bubble call
	// this; it optimistically clears them, POSTs the decision, then re-polls so
	// the dispatch card (run) or the hold-off note (dismiss) lands. Safe on
	// double-tap/expiry — the server only acts on a still-'gated' proposal.
	async function confirmProposal(m: ChatMessage, decision: 'run' | 'dismiss') {
		const taskId = m.trace_id;
		if (!taskId) return;
		messages = messages.map((x) =>
			x.id === m.id ? { ...x, status: decision === 'run' ? 'approved' : 'denied' } : x
		);

		// Spawn the work surface BEFORE the network round-trip so the pill
		// appears instantly on Run (Dynamic Island feel). Idempotent — safe on
		// double-tap.
		if (decision === 'run') {
			ensureSurfaceForTrace(taskId, m);
			// Open the SSE stream so onTerminal fires when the worker lands.
			ensureDispatchStream(taskId);
		}

		try {
			await fetch(resolve('/api/chat/dispatch/confirm'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ taskId, decision })
			});
		} catch {
			/* offline — the next poll reconciles the real state */
		}
		void pollMessages();
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
				// When switching threads, try to restore a saved scroll position
				// first. If none is stored (new or fully-read thread), fall through
				// to scroll-to-bottom as usual.
				if (forThread) {
					queueMicrotask(() => {
						if (!feedContainer) return;
						const restored = restoreScrollPos(forThread, feedContainer);
						if (restored === null) scrollFeedToBottom('auto');
					});
				} else if (userAtBottom) {
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

		// 90s safety timeout — if the stream stalls (mobile network drop,
		// upstream provider hang, etc.) we auto-abort rather than leave the
		// composer in the pulse-fade "sending" state forever. Operator feedback
		// 2026-06-02: "the pulsing fading composer is just hanging." The
		// composer's send-slot also becomes a Stop button while sending=true so
		// the operator can cancel manually before the timeout.
		const sendTimeout = setTimeout(() => {
			streamingCtrl.abort();
			toasts.add('Reply stalled — stopped after 90s. Try again or switch model.', 'error');
		}, 90_000);

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
			clearTimeout(sendTimeout);
			sending = false;
		}
	}

	/** Operator-initiated stop: hits the streaming controller's abort path.
	 *  Wired into the composer's send-slot when sending=true. */
	function abortSend() {
		streamingCtrl.abort();
	}

	function handleKey(e: KeyboardEvent) {
		// onkeydown (not onkeypress) fires during IME composition too, so guard
		// on isComposing — otherwise Enter-to-confirm a composition would send.
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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
		getAudioEl: () => audioEl,
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
		getProviderOverride: () => providerOverride,
		getToolsKey: () => toolsKey,
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
	// Service-worker → page channel for the WARM notification-tap deep-link.
	let swMessageHandler: ((e: MessageEvent) => void) | null = null;

	onMount(() => {
		void loadTier(threadsCtrl.activeThread);

		// COLD-START notification deep-link: the thread is already resolved
		// server-side (restore order, step 1 = ?thread=). If the push also carried a
		// trace_id, focus that task's work-surface card once the feed has mounted.
		const coldTrace = $page.url.searchParams.get('trace_id');
		if (coldTrace) queueMicrotask(() => focusTraceCard(coldTrace));
		// Invalid/missing deep-linked thread → plain-English fallback (never a blank
		// screen). The server already fell back to the last-active conversation.
		if (data.deepLinkMiss) {
			toasts.add('That conversation is no longer available — showing your latest chat.', 'info');
		}
		// WARM notification deep-link: SW focuses this client and postMessages the
		// target URL so we switch to the exact thread + focus the card without a reload.
		swMessageHandler = (e: MessageEvent) => {
			if (e.data?.type === 'deep-link' && typeof e.data.url === 'string') {
				void handleDeepLink(e.data.url);
			}
		};
		navigator.serviceWorker?.addEventListener('message', swMessageHandler);
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
						// Operator reached the bottom — clear the saved scroll pos for
						// this thread so next open starts fresh at the bottom.
						clearScrollPos(threadsCtrl.activeThread);
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
		if (swMessageHandler) navigator.serviceWorker?.removeEventListener('message', swMessageHandler);
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

<!-- ARIA role intentionally omitted: a landmark here would nest <aside> and
		<main> inside another landmark and break the page hierarchy (axe-core
		landmark-*-is-top-level violations). Drag-drop intent is conveyed
		visually via the overlay rendered inside <Composer> when isDragging. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="relative flex h-[100dvh] w-full overflow-hidden font-sans text-foreground"
	ondragenter={composerCtrl.handleDragEnter}
	ondragover={composerCtrl.handleDragOver}
	ondragleave={composerCtrl.handleDragLeave}
	ondrop={composerCtrl.handleDrop}
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
		<!-- Visually hidden page heading — satisfies the page-has-heading-one
		     a11y requirement without imposing visible chrome. ChatHeader's
		     <span>Sully</span> wordmark is intentionally not an <h1> because
		     it's the persistent app identity, not the page heading. -->
		<h1 class="sr-only">Sully chat</h1>
		<!-- ═════════════════════════════════════════════════════════════════
		     QUIET HEADER
		     ═════════════════════════════════════════════════════════════════ -->
		<ChatHeader
			bind:workspaceContextOpen
			ontoggleSidebar={() => (sidebarOpen = !sidebarOpen)}
			onopenWorkspaceContext={() => void openWorkspaceContextEditor()}
		/>

		<!-- ═════════════════════════════════════════════════════════════════
		     EPHEMERAL ACTIVITY PILL
		     ═════════════════════════════════════════════════════════════════ -->
		{#if activityPill}
			<div
				class="relative z-10 mx-auto shrink-0 px-4 pb-1 select-none"
				style="animation: fade-in var(--dur-slow) ease-out;"
			>
				<div
					class="inline-flex items-center gap-2 rounded-[var(--r-pill)] border border-cyan-400/25 bg-cyan-950/20 px-3.5 py-1.5 backdrop-blur-md"
					style="box-shadow: var(--shadow-accent);"
				>
					<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-[var(--r-pill)] bg-cyan-400"
					></span>
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
				onfeedback={(m, s) => void messageActions.feedbackMessage(m, s)}
				onproposal={(m, decision) => void confirmProposal(m, decision)}
				{openCanvas}
				onimagepreview={(src, alt) => {
					lightboxImage = { src, alt };
				}}
				{ensureDispatchStream}
				{fmtTime}
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
				class="absolute right-1/2 bottom-24 z-20 flex translate-x-1/2 items-center gap-1 rounded-[var(--r-pill)] border border-cyan-400/30 bg-cyan-400/10 px-3.5 py-1.5 font-sans text-[11px] text-cyan-300 backdrop-blur-md transition-all select-none hover:scale-105 active:scale-95"
				style="box-shadow: var(--shadow-accent);"
			>
				{unseenCount} new messages ↓
			</button>
		{/if}

		{#snippet composerEl()}
			<Composer
				bind:textDraft={() => composerCtrl.textDraft, (v) => (composerCtrl.textDraft = v)}
				bind:imageMode
				bind:isDragging={() => composerCtrl.isDragging, (v) => (composerCtrl.isDragging = v)}
				bind:textareaEl
				bind:showModelOverrideModal
				attachments={composerCtrl.attachments}
				{composerMode}
				{sending}
				talkbackPhase={voice.phase}
				{slashMode}
				{slashMatches}
				{selectedModelChoice}
				{MODEL_CHOICES}
				{pickerProvider}
				{lastModelUsed}
				onsend={() => void sendMessage()}
				onabort={abortSend}
				onpaste={composerCtrl.handlePaste}
				onkey={handleKey}
				onfocus={() => composerMode === 'idle' && (composerMode = 'focused')}
				onblur={() => composerMode === 'focused' && (composerMode = 'idle')}
				ontriggerUpload={triggerUpload}
				ontoggleTalkback={() => void voiceMode.toggleTalkback()}
				onstopTalkback={() => void voice.stopTalkback()}
				onvoiceMode={() => void voiceMode.enterFullVoice()}
				onpickSlash={(cmd) => void pickSlash(cmd)}
				onremoveAttachment={composerCtrl.removeAttachment}
				onsetModelChoice={(choice) => void setModelChoice(choice)}
				oncloseAllPopovers={closeAllPopovers}
			/>
		{/snippet}

		<!-- Composer mount gate (LOS-176 / T1b): in full voice the composer is
		     UNMOUNTED — actually removed from the component tree, not hidden — so
		     streaming voice updates can't re-render it and its reactive closures
		     can't leak. The full-screen VoiceMode overlay owns the screen instead.
		     The {#if} (not display:none) is what makes the unmount real. -->
		{#if voiceMode.composerMounted}
			<!-- LOS-192 part 1: composer mounts bare. The legacy work-surface
			     chrome (pill + dock + sheet) that wrapped it is retired — the
			     feed's WorkerPill is the run surface now; the tap-to-open run
			     sheet returns in part 2. -->
			{@render composerEl()}
		{/if}
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

<ImageLightbox
	src={lightboxImage?.src ?? null}
	alt={lightboxImage?.alt ?? ''}
	onclose={() => (lightboxImage = null)}
/>

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
