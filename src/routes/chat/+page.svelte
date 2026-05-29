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
	//   - 100% wired controls (Mic dictation, Paperclip uploads, Sparkles image mode, Talkback loop).

	import { onMount, onDestroy, untrack } from 'svelte';
	import { resolve } from '$app/paths';
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
	import { createVoiceController } from '$lib/chat/voice.svelte';
	import { replaceState } from '$app/navigation';
	import { Chat } from '@ai-sdk/svelte';
	import { DefaultChatTransport } from 'ai';
	import { Sparkles, Check, Copy, RefreshCw } from 'lucide-svelte';
	import { toasts } from '$lib/utils/toasts';
	import Markdown from '$lib/components/Markdown.svelte';
	import Canvas from '$lib/components/Canvas.svelte';
	import WorkspaceContextModal from '$lib/components/WorkspaceContextModal.svelte';
	import ThreadsSidebar from '$lib/components/ThreadsSidebar.svelte';
	import ChatHeader from '$lib/components/ChatHeader.svelte';
	import Composer from '$lib/components/Composer.svelte';

	let { data } = $props();

	// ─────────────────────────────────────────────────────────────────────
	// State Declarations
	// ─────────────────────────────────────────────────────────────────────
	// `ChatMessage` (the client view-model row) now lives in $lib/types/chat-ui
	// so the voice controller can share it.
	let messages = $state<ChatMessage[]>(data.messages || []);
	let activeThread = $state(data.activeThread || 'default');
	let workspaces = $state(data.workspaces || []);
	let threads = $state(data.threads || []);

	let textDraft = $state('');
	let selectedRepo = $state('LogueOS-Console');
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

	// Composer states
	let composerMode = $state<ComposerMode>('idle');
	let openChip = $state<null | 'repo' | 'thread'>(null);

	// Sidebar / thread-management state — declared up here (not next to the
	// rest of thread-management code lower in the file) so the global popover
	// handler can reference it without forward-declaration issues.
	let threadMenuOpenFor = $state<string | null>(null);

	// Close every open popover. Used by the global Escape + click-outside
	// handler below. Replaces the per-popover `fixed inset-0 z-40` backdrop
	// `<button>` pattern that was trapping clicks on other chrome — see audit
	// 2026-05-27 and [[reference_chat_app_competitive_borrows]] for the bug
	// shape.
	function closeAllPopovers() {
		openChip = null;
		showModelOverrideModal = false;
		threadMenuOpenFor = null;
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
		const anyOpen = openChip !== null || showModelOverrideModal || threadMenuOpenFor !== null;
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
	// page-owned (it spans idle/focused/recording/talkback) and the controller
	// writes it through setComposerMode.
	const voice = createVoiceController({
		getActiveThread: () => activeThread,
		getSelectedRepo: () => selectedRepo,
		getMessages: () => messages,
		getAudioEl: () => audioEl,
		getComposerMode: () => composerMode,
		setComposerMode: (m) => (composerMode = m),
		appendDictation: (text) => {
			textDraft = (textDraft + ' ' + text).trim();
		},
		focusComposer: () => textareaEl?.focus(),
		appendMessage: (m) => {
			messages = [...messages, m];
		},
		setCurrentTier: (t) => (currentTier = t),
		setUserAtBottom: (v) => (userAtBottom = v),
		pollMessages
	});

	// Element refs
	let feedContainer = $state<HTMLDivElement | null>(null);
	let scrollSentinel = $state<HTMLDivElement | null>(null);
	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let fileInputEl = $state<HTMLInputElement | null>(null);

	// SDK chat instance — handles streaming sends through /api/chat/sdk-stream.
	// PR 2b.2 (this commit) uses it for the conversational happy path only.
	// Dispatch (@cc/@agy), image-gen, and slash commands still go through the
	// legacy non-streaming /api/chat. PR 2b.3 deletes the legacy stream path.
	// Server assembles context from chat_messages DB on each request, so the
	// SDK chat.messages is just a streaming pipe — reset between sends.
	//
	// IMPORTANT: SDK 6's Chat class does NOT accept `api`/`body` shorthand at
	// the top level (those are ignored silently — caused PR 2b.2 first-run
	// bug where sends went to the default `/api/chat`, not `/console/api/chat/
	// sdk-stream`). Use `DefaultChatTransport` instead.
	const sdkChat = new Chat({
		transport: new DefaultChatTransport({
			api: resolve('/api/chat/sdk-stream'),
			body: () => ({
				thread: activeThread,
				target_repo: selectedRepo,
				provider: providerOverride === 'gemini' ? 'google' : (providerOverride ?? undefined)
			})
		})
	});
	// While an SDK stream is active, this carries the placeholder bubble's
	// id AND the owning thread's id. Tracking the thread is critical: if the
	// operator switches threads mid-stream, pollMessages for the NEW thread
	// must NOT be suppressed — only the old thread's poll race needs gating.
	// Per CR review on PR #129.
	let streamState = $state<{ placeholderId: number; threadId: string } | null>(null);

	// Pending attachments — uploads stage here as removable chips above the
	// composer rather than getting injected as markdown into the textarea.
	// On send, each attachment's markdown link is appended to the outgoing
	// message body so the server-side rendering stays unchanged. A `text`
	// field on an Attachment marks it as a paste-to-attachment chip — the
	// content lives in memory, no upload, folded into the message body as
	// a fenced code block on send. See [[reference_chat_app_competitive_borrows]]
	// for the ChatGPT-borrow rationale (long pastes auto-convert to keep
	// composer clean + prevent context-window blowout).
	let attachments = $state<Attachment[]>([]);

	// Canvas (Artifacts) side panel — PR A of #20 epic. View-only for now;
	// multi-tab + persistence land in follow-up PRs.
	let canvasArtifact = $state<{ code: string; language: string } | null>(null);
	function openCanvas(code: string, language: string) {
		canvasArtifact = { code, language };
	}
	function closeCanvas() {
		canvasArtifact = null;
	}
	const PASTE_TO_ATTACHMENT_THRESHOLD = 5000;

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

	// ─────────────────────────────────────────────────────────────────────
	// Draft Persist Effect
	// ─────────────────────────────────────────────────────────────────────
	let draftDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let draftPersistFailing = $state(false); // shown as a subtle inline indicator
	$effect(() => {
		const text = textDraft;
		if (draftDebounceTimer) clearTimeout(draftDebounceTimer);
		draftDebounceTimer = setTimeout(() => {
			const tid = activeThread;
			void fetch(resolve(`/api/chat/drafts?thread_id=${encodeURIComponent(tid)}`), {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ body: text })
			})
				.then((r) => {
					// Surface persistent failures so the operator knows their draft
					// is in volatile memory only. Previously we swallowed the error
					// entirely — operator would lose work on tab close without ever
					// seeing a warning. Audit 2026-05-27.
					if (!r.ok) {
						if (!draftPersistFailing) {
							console.warn('[draft] persist failed:', r.status);
							toasts.add(
								`Draft autosave failing (${r.status}) — finish your message before closing the tab.`,
								'warning'
							);
							draftPersistFailing = true;
						}
					} else if (draftPersistFailing) {
						draftPersistFailing = false;
					}
				})
				.catch((err) => {
					if (!draftPersistFailing) {
						console.warn('[draft] network error:', err);
						toasts.add(
							'Draft autosave failing — finish your message before closing the tab.',
							'warning'
						);
						draftPersistFailing = true;
					}
				});
		}, 400);
	});

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

	// Chip-display tier: prefer the operator's explicit override over the
	// classifier-driven `currentTier`. Server keeps current_tier untouched
	// when an override is set (override doesn't retrain the classifier),
	// so without this we'd display the classifier's tier even though the
	// operator manually chose a different one.
	const effectiveTier = $derived(operatorOverride ?? currentTier);
	const selectedModelChoice = $derived(
		MODEL_CHOICES.find(
			(c) =>
				(c.tier ?? null) ===
					(effectiveTier === 'chat' && !providerOverride && !operatorOverride
						? null
						: effectiveTier) && c.provider === providerOverride
		) ?? MODEL_CHOICES[0]
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
		try {
			const resp = await fetch(resolve('/api/chat/tier'), {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					thread_id: activeThread,
					tier: choice.tier,
					provider: choice.provider
				})
			});
			if (resp.ok) {
				const body = await resp.json();
				if (body.current_tier) currentTier = body.current_tier as Tier;
				operatorOverride = (body.operator_override ?? null) as Tier | null;
				providerOverride = (body.provider_override ?? null) as ProviderPref;
				await loadTier(activeThread);
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
		const requestedThread = forThread ?? activeThread;
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
			if (requestedThread !== activeThread) return;
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
					queueMicrotask(() => scrollSentinel?.scrollIntoView({ behavior: 'smooth' }));
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
				if (new Date(row.timestamp).getTime() < cutoff) continue;
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
		textDraft = '';
		attachments = [];
		queueMicrotask(() => scrollSentinel?.scrollIntoView({ behavior: 'smooth' }));

		// Routing decision: if the message looks like an explicit worker
		// dispatch or it's an image-gen request, use the non-streaming
		// /api/chat endpoint. Otherwise stream tokens via the SDK (which
		// hits /api/chat/sdk-stream — see runStreamingSend below).
		const lower = messageBody.toLowerCase();
		const isDispatch = lower.includes('@cc') || lower.includes('@agy') || lower.includes('@gemini');
		const useStream = !isDispatch && !isGenImage;

		try {
			if (useStream) {
				await runStreamingSend(messageBody);
			} else {
				const r = await fetch(resolve('/api/chat'), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						message: messageBody,
						thread: activeThread,
						target_repo: selectedRepo,
						image: isGenImage || undefined
					})
				});
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				await pollMessages();
			}
		} catch (e) {
			toasts.add(`Send failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error');
			textDraft = text; // restore
		} finally {
			sending = false;
		}
	}

	function handlePaste(e: ClipboardEvent) {
		const items = Array.from(e.clipboardData?.items ?? []);
		const imageFiles = items
			.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
			.map((it) => it.getAsFile())
			.filter((f): f is File => f !== null);
		if (imageFiles.length > 0) {
			e.preventDefault();
			for (const f of imageFiles) {
				void uploadOneFile(f);
			}
			return;
		}
		// Long-paste auto-attach (ChatGPT-borrow #19): pastes over the
		// threshold get converted to an attachment chip rather than dumped
		// into the textarea. Keeps the composer clean and prevents huge
		// context-window blowout when pasting logs / docs / JSON. The text
		// is folded back into the message body as a fenced code block on send.
		const pastedText = e.clipboardData?.getData('text/plain') ?? '';
		if (pastedText.length > PASTE_TO_ATTACHMENT_THRESHOLD) {
			e.preventDefault();
			const id =
				typeof crypto !== 'undefined' && 'randomUUID' in crypto
					? crypto.randomUUID()
					: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const ts = new Date().toISOString().slice(11, 19);
			attachments = [
				...attachments,
				{
					id,
					filename: `paste-${ts}.txt`,
					url: '',
					mime: 'text/plain',
					size: pastedText.length,
					text: pastedText
				}
			];
			toasts.add(`Pasted ${pastedText.length.toLocaleString()} chars as attachment`, 'info');
		}
	}

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void sendMessage();
		}
	}

	// Set of message ids currently showing the "Copied" check on their copy
	// button. Cleared 1500ms after copy fires.
	// Regenerate flow — operator clicks "Regenerate" on an AGY reply. We
	// find the prior operator message in the same thread, delete the
	// existing reply, then re-stream a new one. Old reply gets replaced
	// rather than stacking up.
	let regeneratingIds = $state(new Set<number>());
	async function regenerateReply(m: ChatMessage) {
		if (sending || regeneratingIds.has(m.id)) return;
		// Find the most recent operator message before this reply.
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
		sending = true;
		try {
			// Drop the old reply server-side + optimistically from the feed so
			// the streamed replacement lands in the right place.
			await fetch(resolve(`/api/chat?id=${m.id}`), { method: 'DELETE' }).catch(() => null);
			messages = messages.filter((x) => x.id !== m.id);
			await runStreamingSend(priorOperator.message);
		} catch (e) {
			toasts.add(`Regenerate failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error');
		} finally {
			sending = false;
			regeneratingIds = new Set([...regeneratingIds].filter((i) => i !== m.id));
		}
	}

	let copiedIds = $state(new Set<number>());
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

	// Streaming send via @ai-sdk/svelte's Chat against /api/chat/sdk-stream.
	// Inserts a placeholder assistant bubble (sender derived from active
	// provider), the SDK transport handles the token stream, and the server's
	// onFinish callback persists the canonical row. pollMessages() at the
	// end reconciles the placeholder against the canonical numeric-id row.
	// Mirror SDK chat's streaming text into the placeholder bubble so the rest
	// of the chat surface keeps a single render path off `messages`. While a
	// stream is active, the last assistant message in chat.messages carries
	// the in-progress reply — copy its text into the local placeholder row.
	//
	// Wrap the messages-write in untrack(): reading `messages` inside the
	// effect would self-trigger every time we write, blowing up Svelte's
	// effect_update_depth_exceeded guard. We only want the effect to re-run
	// when sdkChat.messages changes, not when our own write lands.
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
			messages = messages.map((m) => (m.id === id ? { ...m, message: txt } : m));
		});
		if (userAtBottom) {
			queueMicrotask(() => scrollSentinel?.scrollIntoView({ behavior: 'smooth' }));
		}
	});

	async function runStreamingSend(messageBody: string) {
		const STREAM_ID = Date.now() + 1; // distinct from the operator optimistic id
		// Insert an empty placeholder; tokens will append. With this bubble
		// present, the thinking-dots indicator suppresses (last msg !== operator).
		// Sender derived from active provider so the bubble label (AGY / CC)
		// matches what the SDK endpoint will persist. pollMessages reconciles
		// to the canonical DB row after the stream completes.
		const placeholderSender: ChatMessage['sender'] =
			providerOverride === 'anthropic' ? 'cc' : providerOverride === 'local' ? 'local' : 'agy';
		messages = [
			...messages,
			{
				id: STREAM_ID,
				sender: placeholderSender,
				message: '',
				timestamp: new Date().toISOString()
			} as ChatMessage
		];
		streamState = { placeholderId: STREAM_ID, threadId: activeThread };

		// Reset SDK chat history before each send — the server assembles the
		// real context from chat_messages DB. We use sdkChat strictly as a
		// streaming transport, not a context store. Without the reset, each
		// send would carry the previous SDK turns as duplicate body.messages.
		// (@ai-sdk/svelte exposes `messages` as a direct setter, not a
		// setMessages() method — that's react-only.)
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
			messages = messages.map((m) => (m.id === STREAM_ID ? { ...m, message: `⚠️ ${rawMsg}` } : m));
		} finally {
			streamState = null;
			if (errored) {
				messages = messages.filter((m) => m.id !== STREAM_ID);
			}
		}

		// Reconcile against the persisted DB state — the SDK endpoint's
		// onFinish callback wrote the assistant row before closing the stream,
		// so pollMessages picks up the canonical numeric-id row and the
		// optimistic STREAM_ID placeholder gets replaced. CRITICAL: without
		// this call, the placeholder's sender label (set from client-side
		// providerOverride above) stays stale — DB has the right sender but
		// the UI never refreshes to show it.
		if (!errored) {
			await pollMessages();
		}
	}

	// Tiny local-only setter for the model label badge — avoids hitting the
	// /api/chat/tier roundtrip just to display the model used.
	function upsertThreadTier_local(modelUsed: string) {
		if (modelUsed) lastModelUsed = modelUsed;
	}

	// ─────────────────────────────────────────────────────────────────────
	// Paperclip Upload Wiring
	// ─────────────────────────────────────────────────────────────────────
	function triggerUpload() {
		fileInputEl?.click();
	}

	// Uploads a single File via /api/chat/uploads and stages it as a chip.
	// Shared between the paperclip-triggered <input type=file> and the
	// drag-and-drop handler. Errors surface via toast; success is silent
	// because the chip itself is the success indicator.
	async function uploadOneFile(file: File): Promise<void> {
		const tempId = crypto.randomUUID();
		attachments = [
			...attachments,
			{
				id: tempId,
				filename: file.name,
				url: '',
				mime: file.type,
				size: file.size,
				uploading: true
			}
		];
		const fd = new FormData();
		fd.append('file', file);
		fd.append('target_repo', selectedRepo);
		try {
			toasts.add(`Uploading ${file.name}...`, 'info');
			const r = await fetch(resolve('/api/chat/uploads'), {
				method: 'POST',
				body: fd
			});
			if (!r.ok) {
				const err = await r.json().catch(() => ({}));
				throw new Error(err.message || `HTTP ${r.status}`);
			}
			const body = await r.json();
			if (body.url) {
				attachments = attachments.map((a) =>
					a.id === tempId
						? {
								...a,
								id: body.filename || tempId,
								url: body.url,
								mime: body.mime || file.type,
								size: body.size || file.size,
								uploading: false
							}
						: a
				);
			}
		} catch (err) {
			attachments = attachments.filter((a) => a.id !== tempId);
			toasts.add(`Upload failed: ${err instanceof Error ? err.message : 'unknown'}`, 'error');
		}
	}

	async function handleUpload(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;
		try {
			await uploadOneFile(file);
			textareaEl?.focus();
		} finally {
			target.value = '';
		}
	}

	// Drag-and-drop wiring. dragover MUST preventDefault for drop to fire.
	// Use a counter for dragenter/leave because they bubble across child
	// elements — naive boolean would flicker as the cursor crosses child
	// boundaries inside the drop zone.
	let isDragging = $state(false);
	let dragCounter = 0;
	function handleDragEnter(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragCounter++;
		isDragging = true;
	}
	function handleDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
	}
	function handleDragLeave(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragCounter = Math.max(0, dragCounter - 1);
		if (dragCounter === 0) isDragging = false;
	}
	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragCounter = 0;
		isDragging = false;
		const files = Array.from(e.dataTransfer?.files ?? []);
		if (files.length === 0) return;
		for (const file of files) {
			await uploadOneFile(file);
		}
		textareaEl?.focus();
	}

	function removeAttachment(id: string) {
		attachments = attachments.filter((a) => a.id !== id);
	}

	// humanSize moved into <Composer /> with the staged-attachments chip row
	// in Task #7 PR 4.

	// ─────────────────────────────────────────────────────────────────────
	// Sidebar / Thread Management
	// ─────────────────────────────────────────────────────────────────────
	async function switchThread(threadId: string) {
		if (threadId === activeThread) {
			sidebarOpen = false;
			return;
		}
		activeThread = threadId;
		sidebarOpen = false;
		messages = [];
		// Pass the target thread explicitly so pollMessages can drop the
		// response if another switch happens before this fetch returns.
		await pollMessages(threadId);
		await loadTier(threadId);
		// Sync the URL's ?thread= query param without triggering a server
		// data re-fetch. goto() re-runs +page.server.ts load() which fires
		// DB reads + a network round-trip every thread switch — and on iOS PWA,
		// if that fetch hits the service worker while the network hiccups, the
		// SW's fallback returns a plain-text 503 that SvelteKit can't parse,
		// surfacing as "Network connection unavailable." to the operator.
		// replaceState() does a shallow navigation: URL bar updates, no load()
		// re-run, no network request.
		try {
			replaceState(resolve('/chat') + '?thread=' + encodeURIComponent(threadId), {});
		} catch {
			/* navigation failure shouldn't break the in-page switch */
		}
	}

	function switchRepo(name: string) {
		selectedRepo = name;
		openChip = null;
	}

	function slugifyThreadName(name: string): string {
		return (
			name
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9-]+/g, '-')
				.replace(/^-+|-+$/g, '')
				.slice(0, 40) || 'thread'
		);
	}

	// Resolve a guaranteed-clean slug for a new thread. Checks both the local
	// sidebar list AND the DB for residual messages — covers three cases the
	// operator hit:
	//   (1) name collides with an active thread → suffix -2, -3, ...
	//   (2) name collides with an archived-and-hidden thread → suffix
	//   (3) name collides with orphan chat_messages rows left behind by a
	//       Clear-All / Delete that didn't fully cascade → suffix
	// Without this, switchThread() would re-open the existing/orphan thread
	// and pollMessages() would surface the old content — which is exactly
	// what the operator described as "the old thread shows up instead of a
	// clean slate."
	async function findUniqueSlug(baseSlug: string): Promise<string> {
		const localUsed = new Set(threads.map((t) => t.thread_id));
		let slug = baseSlug;
		let i = 1;
		while (i < 200) {
			if (!localUsed.has(slug)) {
				// Probe the DB — orphan rows survive a failed delete.
				try {
					const r = await fetch(
						resolve('/api/chat') + `?thread=${encodeURIComponent(slug)}&limit=1`
					);
					if (r.ok) {
						const b = await r.json();
						if (!Array.isArray(b.messages) || b.messages.length === 0) return slug;
					} else {
						return slug; // assume free if probe failed
					}
				} catch {
					return slug; // offline → assume free
				}
			}
			i++;
			slug = `${baseSlug}-${i}`;
		}
		return `${baseSlug}-${Date.now()}`; // safety net — shouldn't reach here
	}

	// ChatGPT-style: click + and you immediately get a new thread. No prompt
	// (`window.prompt()` is silently blocked on iOS Safari + most PWAs, which
	// is exactly the surface the operator runs on most). Auto-generates a
	// slug like "chat-7m3q2" — short, collision-tolerant via findUniqueSlug,
	// rename via the ⋮ menu after the first message lands. Mirrors how
	// ChatGPT/Claude/Gemini all behave.
	async function newThread() {
		const stamp = Date.now().toString(36).slice(-5);
		const baseSlug = `chat-${stamp}`;
		const slug = await findUniqueSlug(baseSlug);
		const title = 'New thread';
		threads = [
			{
				thread_id: slug,
				title,
				archived: false,
				pinned: false,
				message_count: 0,
				latest_ts: ''
			},
			...threads
		];
		void switchThread(slug);
	}

	// ─────────────────────────────────────────────────────────────────────
	// Thread management — rename / archive / delete / clear-all. Backend is
	// /api/chat/threads/[id] PATCH (title/archived) + DELETE (archived only).
	// `threadMenuOpenFor` is declared up near the other popover-state vars so
	// the global Escape / click-outside handler can reference it.
	// ─────────────────────────────────────────────────────────────────────
	let renamingFor = $state<string | null>(null);
	let renameDraft = $state('');
	let showArchived = $state(false);

	function openRename(t: { thread_id: string; title: string }) {
		threadMenuOpenFor = null;
		renamingFor = t.thread_id;
		renameDraft = t.title || t.thread_id;
	}
	async function commitRename(threadId: string) {
		const title = renameDraft.trim();
		renamingFor = null;
		if (!title) return;
		// Optimistic update.
		threads = threads.map((t) => (t.thread_id === threadId ? { ...t, title } : t));
		try {
			await fetch(resolve(`/api/chat/threads/${encodeURIComponent(threadId)}`), {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title })
			});
		} catch {
			toasts.add('Rename failed — try again', 'error');
		}
	}
	function cancelRename() {
		renamingFor = null;
		renameDraft = '';
	}

	async function toggleArchive(t: { thread_id: string; archived: boolean }) {
		threadMenuOpenFor = null;
		const archived = !t.archived;
		threads = threads.map((x) => (x.thread_id === t.thread_id ? { ...x, archived } : x));
		try {
			await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ archived })
			});
			toasts.add(archived ? `Archived "${t.thread_id}"` : `Restored "${t.thread_id}"`, 'success');
		} catch {
			toasts.add('Archive failed', 'error');
		}
	}

	async function togglePin(t: { thread_id: string; pinned: boolean }) {
		threadMenuOpenFor = null;
		const pinned = !t.pinned;
		threads = threads.map((x) => (x.thread_id === t.thread_id ? { ...x, pinned } : x));
		try {
			await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pinned })
			});
			toasts.add(pinned ? `Pinned "${t.thread_id}"` : `Unpinned "${t.thread_id}"`, 'success');
		} catch {
			toasts.add('Pin update failed', 'error');
		}
	}

	async function deleteThreadById(t: { thread_id: string; archived: boolean }) {
		threadMenuOpenFor = null;
		// Backend requires archived=true before delete. Auto-archive if needed.
		if (!t.archived) {
			await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ archived: true })
			}).catch(() => null);
		}
		const ok = window.confirm(
			`Delete thread "${t.thread_id}"? This permanently removes all messages, drafts, and metadata for it.`
		);
		if (!ok) return;
		try {
			const r = await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
				method: 'DELETE'
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			threads = threads.filter((x) => x.thread_id !== t.thread_id);
			if (activeThread === t.thread_id) {
				// Switch to the next available thread, or a fresh one if list is empty.
				const next = threads[0]?.thread_id;
				if (next) await switchThread(next);
				else await newThread();
			}
			toasts.add(`Deleted "${t.thread_id}"`, 'success');
		} catch (e) {
			toasts.add(`Delete failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error');
		}
	}

	async function clearAllSessions() {
		const ok = window.confirm(
			'Archive and delete every thread? This cannot be undone. A fresh thread will be created after.'
		);
		if (!ok) return;
		let removed = 0;
		for (const t of threads) {
			try {
				await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ archived: true })
				});
				const r = await fetch(resolve(`/api/chat/threads/${encodeURIComponent(t.thread_id)}`), {
					method: 'DELETE'
				});
				if (r.ok) removed++;
			} catch {
				/* skip */
			}
		}
		threads = [];
		toasts.add(`Cleared ${removed} thread${removed === 1 ? '' : 's'}`, 'success');
		// Hand the operator a fresh thread instead of an empty surface.
		await newThread();
	}

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

	const SLASH_COMMANDS: SlashCmd[] = [
		{
			key: 'clear',
			usage: '/clear',
			description: 'Reset conversation context (server slices history at this marker)',
			run: async () => {
				// Persist a system marker — /api/chat and /api/chat/sdk-stream
				// slice thread history at the latest `--- NEW CONVERSATION ---`
				// line, so this drops the LLM's working memory without deleting
				// prior messages from the operator's view.
				await fetch(resolve('/api/chat'), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						sender: 'system',
						message: '--- NEW CONVERSATION ---',
						thread: activeThread,
						agent: 'silent'
					})
				}).catch(() => null);
				await pollMessages();
				toasts.add('Conversation context reset', 'success');
			}
		},
		{
			key: 'new',
			usage: '/new <name>',
			description: 'Create + switch to a new thread',
			run: async (rest) => {
				const baseSlug = slugifyThreadName(rest);
				if (!baseSlug || baseSlug === 'thread') {
					toasts.add('Thread name required: /new my-feature', 'error');
					return;
				}
				const slug = await findUniqueSlug(baseSlug);
				const title = slug === baseSlug ? rest.trim() || slug : slug;
				if (slug !== baseSlug) {
					toasts.add(`"${baseSlug}" was taken — created "${slug}" for a clean slate.`, 'info');
				}
				threads = [
					{
						thread_id: slug,
						title,
						archived: false,
						pinned: false,
						message_count: 0,
						latest_ts: ''
					},
					...threads
				];
				await switchThread(slug);
				toasts.add(`Switched to thread "${slug}"`, 'success');
			}
		},
		{
			key: 'regen',
			usage: '/regen',
			description: 'Regenerate the most recent assistant reply',
			run: async () => {
				// Walk backwards for the last non-operator, non-system reply
				for (let i = messages.length - 1; i >= 0; i--) {
					if (messages[i].sender !== 'operator' && messages[i].sender !== 'system') {
						await regenerateReply(messages[i]);
						return;
					}
				}
				toasts.add('No assistant reply to regenerate', 'error');
			}
		},
		{
			key: 'help',
			usage: '/help',
			description: 'Show available slash commands',
			run: () => {
				const body = SLASH_COMMANDS.map((c) => `- \`${c.usage}\` — ${c.description}`).join('\n');
				addLocalSystemMessage(`**Slash commands**\n\n${body}`);
			}
		}
	];

	const slashQuery = $derived(
		textDraft.startsWith('/') ? textDraft.slice(1).split(/\s/)[0].toLowerCase() : null
	);
	const slashMatches = $derived(
		slashQuery === null ? [] : SLASH_COMMANDS.filter((c) => c.key.startsWith(slashQuery))
	);
	const slashMode = $derived(
		textDraft.startsWith('/') && !textDraft.includes('\n') && slashMatches.length > 0
	);

	async function runSlashFromDraft(): Promise<boolean> {
		if (!textDraft.startsWith('/')) return false;
		const trimmed = textDraft.trim();
		const spaceIdx = trimmed.indexOf(' ');
		const key = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
		const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
		const cmd = SLASH_COMMANDS.find((c) => c.key === key);
		if (!cmd) return false;
		textDraft = '';
		attachments = [];
		try {
			await cmd.run(rest);
		} catch (e) {
			toasts.add(`Command failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error');
		}
		return true;
	}

	async function pickSlash(cmd: SlashCmd) {
		// If the command takes args (usage has < >), prefill the composer
		// instead of running immediately so the operator can type the arg.
		if (cmd.usage.includes('<')) {
			textDraft = `/${cmd.key} `;
			textareaEl?.focus();
			return;
		}
		textDraft = `/${cmd.key}`;
		await runSlashFromDraft();
	}

	// ─────────────────────────────────────────────────────────────────────
	// Lifecycle
	// ─────────────────────────────────────────────────────────────────────
	let pollTimer: ReturnType<typeof setInterval>;
	let activityTimer: ReturnType<typeof setInterval>;
	let sentinelObs: IntersectionObserver | null = null;

	onMount(() => {
		void loadTier(activeThread);
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
		queueMicrotask(() => scrollSentinel?.scrollIntoView({ behavior: 'auto' }));
		pollTimer = setInterval(pollMessages, 3000);
		activityTimer = setInterval(pollActivity, 5000);
	});

	onDestroy(() => {
		clearInterval(pollTimer);
		clearInterval(activityTimer);
		sentinelObs?.disconnect();
		if (draftDebounceTimer) clearTimeout(draftDebounceTimer);
		if (activityFadeTimer) clearTimeout(activityFadeTimer);
		void voice.destroy();
	});

	// Utilities
	function fmtTime(iso: string): string {
		try {
			return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		} catch {
			return '';
		}
	}

	function senderDisplay(s: string): string {
		if (s === 'operator') return 'You';
		return s.toUpperCase();
	}
</script>

<svelte:head>
	<title>LogueOS — Conversational Kernel</title>
</svelte:head>

<!-- Persistent audio element for ElevenLabs speech -->
<audio bind:this={audioEl} class="hidden" aria-hidden="true"></audio>
<input
	type="file"
	accept="image/*"
	bind:this={fileInputEl}
	class="hidden"
	onchange={handleUpload}
/>

<div
	class="relative flex h-[100dvh] w-full overflow-hidden bg-[#050505] font-sans text-foreground"
	ondragenter={handleDragEnter}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
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
		{threads}
		{activeThread}
		bind:sidebarOpen
		bind:showArchived
		bind:renamingFor
		bind:renameDraft
		bind:threadMenuOpenFor
		onswitchThread={(id) => void switchThread(id)}
		onnewThread={() => void newThread()}
		oncloseSidebar={() => (sidebarOpen = false)}
		oncommitRename={(id) => void commitRename(id)}
		oncancelRename={cancelRename}
		ontogglePin={(t) => void togglePin(t)}
		ontoggleArchive={(t) => void toggleArchive(t)}
		ondeleteThread={(t) => void deleteThreadById(t)}
		onopenRename={openRename}
		onclearAll={() => void clearAllSessions()}
	/>

	<!-- ═════════════════════════════════════════════════════════════════
	     MAIN CONVERSATIONAL CANVAS
	     ═════════════════════════════════════════════════════════════════ -->
	<main class="relative flex h-full flex-1 flex-col overflow-hidden select-text">
		<!-- ═════════════════════════════════════════════════════════════════
		     QUIET HEADER
		     ═════════════════════════════════════════════════════════════════ -->
		<ChatHeader
			{selectedRepo}
			{selectedWorkspace}
			{workspaces}
			{tierEmoji}
			{lastModelUsed}
			{selectedModelChoice}
			{MODEL_CHOICES}
			bind:openChip
			bind:showModelOverrideModal
			ontoggleSidebar={() => (sidebarOpen = !sidebarOpen)}
			onswitchRepo={switchRepo}
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
					<span class="font-mono text-[11px] tracking-wide text-cyan-400">
						⚡ {activityPill.worker}: {activityPill.step}
					</span>
					<a
						href={resolve('/api/chat/activity')}
						class="ml-1.5 font-mono text-[10px] text-cyan-300/60 transition-colors hover:text-cyan-300"
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
			class="relative z-10 flex flex-1 flex-col gap-6 overflow-y-auto px-4 py-4 md:px-6"
		>
			{#if messages.length === 0}
				<div class="flex flex-1 items-center justify-center text-center select-none">
					<div class="max-w-xs space-y-2">
						<div class="font-sans text-sm font-light text-zinc-500/60">
							Active terminal partner loop established.
						</div>
						<div class="font-mono text-[10px] tracking-widest text-zinc-700 uppercase">
							{selectedWorkspace?.display_name ?? selectedRepo} · {currentTier}
						</div>
					</div>
				</div>
			{:else}
				{#each messages as m (m.id)}
					<!-- Skip rendering the empty stream-placeholder bubble while the
					     thinking-dots block represents it. Once any token text
					     arrives, m.message is non-empty and the bubble re-renders. -->
					{#if !(streamState?.placeholderId === m.id && m.message === '')}
						<div
							class="flex flex-col gap-1 {m.sender === 'operator' ? 'items-end' : 'items-start'}"
						>
							<!-- Custom Labeling / Bubble Headers -->
							{#if m.sender !== 'operator'}
								<div
									class="mb-1.5 flex w-fit items-center gap-1 rounded-full border border-cyan-500/20 bg-cyan-950/20 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-cyan-400 uppercase select-none"
								>
									<Sparkles size={10} class="shrink-0 text-cyan-400" />
									<span>{m.sender === 'system' ? 'LOGUEOS' : senderDisplay(m.sender)}</span>
								</div>
							{/if}

							<!-- Text Bubble. Operator bubbles render raw (whitespace-pre)
						     since they're literally what was typed. Assistant
						     bubbles render through the Markdown component for
						     code-block highlighting, inline code, lists, etc. -->
							<div
								class="max-w-[85%] rounded-2xl px-3.5 py-2 font-sans text-[13.5px] leading-snug tracking-[-0.005em] antialiased selection:bg-purple-900/50 selection:text-white sm:max-w-[80%]
								{m.sender === 'operator'
									? 'border border-orange-500/30 bg-orange-500/[0.03] text-orange-50 shadow-[0_0_20px_rgba(249,115,22,0.06)]'
									: 'border border-zinc-900 bg-zinc-950/40 text-zinc-100'}"
							>
								{#if m.sender === 'operator'}
									<span class="whitespace-pre-wrap">{m.message}</span>
								{:else}
									<Markdown content={m.message} oncanvas={openCanvas} />
								{/if}
							</div>

							<!-- Time + actions footer. Copy + Regenerate on assistant
						     replies only — operator's own bubbles already echo
						     their input and can't be re-rolled. -->
							<div class="flex items-center gap-2 px-1 select-none">
								{#if m.sender !== 'operator' && m.message}
									<button
										type="button"
										onclick={() => copyMessage(m)}
										class="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[9px] tracking-wider text-zinc-600 uppercase transition-colors hover:bg-zinc-900 hover:text-zinc-300"
										aria-label="Copy reply"
										title={copiedIds.has(m.id) ? 'Copied' : 'Copy reply'}
									>
										{#if copiedIds.has(m.id)}
											<Check size={10} class="text-emerald-400" />
											<span class="text-emerald-400">Copied</span>
										{:else}
											<Copy size={10} />
											<span>Copy</span>
										{/if}
									</button>
									<button
										type="button"
										onclick={() => regenerateReply(m)}
										disabled={sending || regeneratingIds.has(m.id)}
										class="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[9px] tracking-wider text-zinc-600 uppercase transition-colors hover:bg-zinc-900 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
										aria-label="Regenerate reply"
										title={regeneratingIds.has(m.id) ? 'Regenerating…' : 'Regenerate reply'}
									>
										<RefreshCw size={10} class={regeneratingIds.has(m.id) ? 'animate-spin' : ''} />
										<span>{regeneratingIds.has(m.id) ? 'Regen…' : 'Regen'}</span>
									</button>
								{/if}
								<div class="font-mono text-[9px] text-zinc-600">
									{fmtTime(m.timestamp)}
								</div>
							</div>
						</div>
					{/if}
				{/each}

				<!-- Thinking indicator — renders an AGY-style bubble with three
				     staggered bouncing dots while we're waiting on a reply.
				     Conditions: a send is in flight AND the most recent message
				     in the feed is from the operator (i.e. we're between their
				     send and the LLM's response landing). -->
				<!-- Thinking dots indicator. Renders during the gap between operator
				     send and first LLM token arriving — that is, when there's a
				     stream placeholder bubble whose text is still empty. Pre-2b.2
				     the trigger was "last message is operator", but the SDK
				     cutover now inserts an optimistic assistant placeholder
				     immediately on send so the old check never fires. We instead
				     gate on streamState (set when a stream starts) AND the
				     placeholder message text being empty (no tokens yet). -->
				{#if streamState && messages.find((m) => m.id === streamState!.placeholderId)?.message === ''}
					<div class="flex flex-col items-start gap-1">
						<div
							class="mb-1.5 flex w-fit items-center gap-1 rounded-full border border-cyan-500/20 bg-cyan-950/20 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-cyan-400 uppercase select-none"
						>
							<Sparkles size={10} class="shrink-0 text-cyan-400" />
							<span
								>{providerOverride === 'anthropic'
									? 'CC'
									: providerOverride === 'local'
										? 'LOCAL'
										: 'AGY'}</span
							>
						</div>
						<div
							class="flex items-center gap-1.5 rounded-2xl border border-zinc-900 bg-zinc-950/40 px-4 py-3.5"
							aria-label="Assistant is thinking"
							role="status"
						>
							<span
								class="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400/70"
								style="animation-delay: 0ms"
							></span>
							<span
								class="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400/70"
								style="animation-delay: 150ms"
							></span>
							<span
								class="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400/70"
								style="animation-delay: 300ms"
							></span>
						</div>
					</div>
				{/if}
			{/if}

			<!-- Tool-call chips for the currently-streaming reply.
			     Rendered from sdkChat.messages's tool-* parts so the operator
			     can see what the LLM is doing on their behalf while waiting.
			     Only visible during an active stream; after the stream
			     completes, sdkChat.messages resets and these disappear.
			     History-mode tool-call display lives in a future PR (would
			     require tool-call persistence into chat_messages). -->
			{#if streamState}
				{#each sdkChat.messages as sdkMsg (sdkMsg.id)}
					{#if sdkMsg.role === 'assistant' && (sdkMsg.parts || []).some( (p) => p.type?.startsWith('tool-') )}
						<div class="flex flex-col items-start gap-1" data-testid="sdk-tool-row">
							{#each sdkMsg.parts as part, i (i)}
								{#if part.type?.startsWith('tool-')}
									<div
										class="my-1 flex flex-col gap-0.5 rounded-lg border border-purple-500/30 bg-purple-500/[0.04] px-2.5 py-1.5 font-mono text-[11px]"
									>
										<div class="flex items-center gap-1.5 text-purple-300">
											<Sparkles size={11} aria-hidden="true" />
											<span class="font-semibold tracking-wide">
												{part.type.replace(/^tool-/, '')}
											</span>
											<span class="ml-auto text-[9px] tracking-wider text-purple-400/70 uppercase">
												{(part as { state?: string }).state ?? 'pending'}
											</span>
										</div>
										{#if (part as { state?: string }).state === 'output-error'}
											<div class="text-[10px] text-red-400">
												{(part as { errorText?: string }).errorText ?? 'tool error'}
											</div>
										{/if}
									</div>
								{/if}
							{/each}
						</div>
					{/if}
				{/each}
			{/if}

			<div bind:this={scrollSentinel} class="h-px shrink-0" aria-hidden="true"></div>
		</div>

		{#if unseenCount > 0 && !userAtBottom}
			<button
				type="button"
				onclick={() => {
					userAtBottom = true;
					unseenCount = 0;
					scrollSentinel?.scrollIntoView({ behavior: 'smooth' });
				}}
				class="absolute right-1/2 bottom-24 z-20 flex translate-x-1/2 items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3.5 py-1.5 font-mono text-[11px] text-cyan-300 backdrop-blur-md transition-all select-none hover:scale-105 active:scale-95"
				style="box-shadow: 0 0 16px rgba(34, 211, 238, 0.2);"
			>
				{unseenCount} new messages ↓
			</button>
		{/if}

		<!-- ═════════════════════════════════════════════════════════════════
		     HERO COMPOSER PILL — extracted to <Composer /> (Task #7 PR 4).
		     Drag handlers stay on the outer wrapper (handleDragEnter/Over/
		     Leave/Drop above); Composer renders the drop overlay conditional
		     on `isDragging`.
		     ═════════════════════════════════════════════════════════════════ -->
		<Composer
			bind:textDraft
			bind:imageMode
			bind:isDragging
			bind:textareaEl
			{attachments}
			{composerMode}
			{sending}
			talkbackPhase={voice.phase}
			{slashMode}
			{slashMatches}
			onsend={() => void sendMessage()}
			onpaste={handlePaste}
			onkey={handleKey}
			onfocus={() => composerMode === 'idle' && (composerMode = 'focused')}
			onblur={() => composerMode === 'focused' && (composerMode = 'idle')}
			ontriggerUpload={triggerUpload}
			ontoggleRecord={() => void voice.toggleRecord()}
			ontoggleTalkback={() => void voice.toggleTalkback()}
			onstopTalkback={() => void voice.stopTalkback()}
			onpickSlash={(cmd) => void pickSlash(cmd)}
			onremoveAttachment={removeAttachment}
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
