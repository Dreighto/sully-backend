<script lang="ts">
	// Chat composer pill — textarea + slash-command autocomplete + staged
	// attachment chips + talkback/image-mode strips + utility buttons
	// (Attach, Sparkles/Image, Talkback, Send/Voice-mode) + the drag-and-drop
	// overlay.
	// Extracted from /chat as Task #7 PR 4 of the +page.svelte decomposition.
	//
	// Self-contained markup, but state crossing the boundary stays as props +
	// callbacks (no store). The parent owns all $state runes; bindable props
	// are used where the parent needs to read the value by name — `textDraft`
	// (parent's draft-persist $effect watches it), `imageMode` (parent's
	// sendMessage reads it), `isDragging` (parent reads its current value),
	// and `textareaEl` (parent uses the DOM ref to focus the textarea after
	// upload, talkback, etc., and `composerMaxHeight` measures it).
	//
	// The textarea auto-grow $effect moves IN with the component — it depends
	// only on `textDraft` and the local `textareaEl`. The draft-persist
	// $effect, however, stays in the parent: it also depends on `activeThread`
	// which is parent-owned. The global popover-close $effect also stays in
	// the parent — composer doesn't host popovers keyed on those vars.
	//
	// ARIA labels (`Send Message`, `Attach File`, `Toggle Image Gen Mode`,
	// `Voice mode`, `Hands-free continuous Talkback`) and tap-target
	// sizes (h-11 w-11 on mobile, sm:h-9 sm:w-9 on desktop) are load-bearing
	// for the chat e2e suite and PR #143's mobile spec. Do not change.

	import { base } from '$app/paths';
	import type { SlashCmd } from '$lib/types/slash';
	import type { Attachment, ComposerMode, ModelChoice, TalkbackPhase } from '$lib/types/chat-ui';
	import {
		Send,
		Paperclip,
		Sparkles,
		Headphones,
		Square,
		X,
		Loader2,
		AudioLines,
		Plus,
		BookOpen,
		ChevronUp,
		Check
	} from 'lucide-svelte';
	import { fade, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { TransitionConfig } from 'svelte/transition';
	import type { ActionReturn } from 'svelte/action';

	// Portal action — moves the node to <body> on mount, removes it on
	// destroy. Used ONLY on mobile (< lg) so the model-picker sheet + its
	// backdrop scrim escape any ancestor with backdrop-filter, which (per
	// CSS spec) creates a containing block for position:fixed descendants
	// and would otherwise clip the sheet. Desktop (lg+) leaves the popover
	// in place so its `lg:absolute lg:bottom-full lg:right-0` can anchor
	// against the trigger chip's wrapping `<div class="relative">`.
	// Viewport captured ONCE at mount; rotating mid-popover-open is an
	// edge case we accept.
	function mobilePortal(node: HTMLElement): ActionReturn | void {
		if (typeof window === 'undefined') return;
		if (window.innerWidth >= 1024) return;
		document.body.appendChild(node);
		return {
			destroy() {
				if (node.parentNode === document.body) node.remove();
			}
		};
	}

	// Responsive transition for the model-picker surface.
	//
	// Below lg: bottom-anchored sheet that slides up + fades in (sheets
	// feel cheap when they also scale, so no scale on mobile). At lg+:
	// dropdown that BLOOMS UPWARD from the trigger chip (chip is now next
	// to the composer at the bottom of the screen, so the dropdown opens
	// above it). transform-origin: bottom right anchors the scale anim to
	// the chip's corner. Branches once at start so rotation mid-anim stays
	// consistent. SSR-safe via the `typeof window` guard.
	function sheetTransition(_node: Element): TransitionConfig {
		const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 1024;
		if (isDesktop) {
			return {
				duration: 220,
				easing: cubicOut,
				css: (t) => {
					const scaleVal = 0.94 + 0.06 * t;
					// bottom-left because the desktop dropdown anchors to the
					// chip's LEFT edge (lg:left-0) and extends rightward into
					// the message canvas — anchoring right would push the
					// dropdown UNDER the persistent sidebar (z-[60] > z-50).
					return `opacity: ${t}; transform: scale(${scaleVal}); transform-origin: bottom left;`;
				}
			};
		}
		return {
			duration: 280,
			easing: cubicOut,
			css: (t) => {
				const y = (1 - t) * 100;
				return `opacity: ${t}; transform: translateY(${y}%);`;
			}
		};
	}

	// Swipe-to-dismiss gesture for the mobile bottom sheet. iOS-canonical
	// behavior: while the sheet's internal scroll is at the top (scrollTop
	// === 0), a downward drag follows the finger; releasing past a 100px
	// threshold dismisses the sheet, otherwise it springs back. When the
	// list is scrolled, normal scroll wins — the gesture only takes over
	// once the user is at the top trying to "pull down past the edge".
	// Mobile-only: registers no listeners at lg+.
	function swipeToDismiss(
		node: HTMLElement,
		params: { onDismiss: () => void }
	): ActionReturn | void {
		if (typeof window === 'undefined') return;
		if (window.innerWidth >= 1024) return;

		const THRESHOLD_PX = 100;
		let startY = 0;
		let delta = 0;
		let dragging = false;
		let armed = false; // true once we've decided this gesture is a dismiss-drag (vs a scroll)

		function onStart(e: TouchEvent) {
			if (e.touches.length !== 1) return;
			startY = e.touches[0].clientY;
			delta = 0;
			dragging = true;
			armed = node.scrollTop <= 0;
			node.style.transition = 'none';
		}

		function onMove(e: TouchEvent) {
			if (!dragging || e.touches.length !== 1) return;
			const y = e.touches[0].clientY;
			const d = y - startY;
			// If user starts dragging at scrollTop=0 and pulls down, take over.
			if (!armed && node.scrollTop <= 0 && d > 0) armed = true;
			if (!armed) return;
			if (d < 0) {
				// Upward drag: snap to 0, don't go negative.
				delta = 0;
				node.style.transform = 'translateY(0)';
				return;
			}
			delta = d;
			node.style.transform = `translateY(${d}px)`;
		}

		function onEnd() {
			if (!dragging) return;
			dragging = false;
			node.style.transition = 'transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1)';
			if (delta > THRESHOLD_PX) {
				// Dismiss — let the parent flip showModelOverrideModal=false; the
				// transition:sheetTransition's `out` phase will animate the rest.
				// Reset the inline transform so the next mount starts clean.
				node.style.transform = '';
				params.onDismiss();
			} else {
				node.style.transform = 'translateY(0)';
			}
		}

		// passive: true on start/move because we never preventDefault — we let
		// the OS keep its scroll affordance for the rows inside the sheet, and
		// only take over when the operator pulls down at the top edge.
		node.addEventListener('touchstart', onStart, { passive: true });
		node.addEventListener('touchmove', onMove, { passive: true });
		node.addEventListener('touchend', onEnd, { passive: true });
		node.addEventListener('touchcancel', onEnd, { passive: true });

		return {
			destroy() {
				node.removeEventListener('touchstart', onStart);
				node.removeEventListener('touchmove', onMove);
				node.removeEventListener('touchend', onEnd);
				node.removeEventListener('touchcancel', onEnd);
			}
		};
	}

	const TALKBACK_PHASE_LABELS: Record<TalkbackPhase, string> = {
		capture: '🔴 Capture',
		transcribe: '🔄 Transcribe',
		dispatch: '📤 Sending',
		speak: '🔈 Reply',
		loop: '↩ Ready'
	};

	const COMPOSER_MIN_PX = 36;
	function composerMaxHeight(): number {
		if (typeof window === 'undefined') return 360;
		return Math.min(Math.round(window.innerHeight * 0.5), 480);
	}

	function humanSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	let {
		textDraft = $bindable(''),
		imageMode = $bindable(false),
		isDragging = $bindable(false),
		textareaEl = $bindable<HTMLTextAreaElement | null>(null),
		showModelOverrideModal = $bindable(false),
		workspaceContextOpen = $bindable(false),
		attachments,
		composerMode,
		sending,
		talkbackPhase,
		slashMode,
		slashMatches,
		selectedModelChoice,
		MODEL_CHOICES,
		tierEmoji,
		lastModelUsed,
		onsend,
		onpaste,
		onkey,
		onfocus,
		onblur,
		ontriggerUpload,
		ontoggleTalkback,
		onstopTalkback,
		onvoiceMode,
		onpickSlash,
		onremoveAttachment,
		onsetModelChoice,
		onopenWorkspaceContext,
		oncloseAllPopovers
	}: {
		textDraft: string;
		imageMode: boolean;
		isDragging: boolean;
		textareaEl: HTMLTextAreaElement | null;
		// Bindable so the parent's global popover-close $effect can null the
		// picker / context modal state; drives the chip's brand-tinted active
		// recipe.
		showModelOverrideModal?: boolean;
		workspaceContextOpen?: boolean;
		attachments: Attachment[];
		composerMode: ComposerMode;
		sending: boolean;
		talkbackPhase: TalkbackPhase | null;
		slashMode: boolean;
		slashMatches: SlashCmd[];
		selectedModelChoice: ModelChoice;
		MODEL_CHOICES: ModelChoice[];
		tierEmoji: string;
		lastModelUsed: string;
		onsend: () => void;
		onpaste: (e: ClipboardEvent) => void;
		onkey: (e: KeyboardEvent) => void;
		onfocus: () => void;
		onblur: () => void;
		ontriggerUpload: () => void;
		ontoggleTalkback: () => void;
		onstopTalkback: () => void;
		onvoiceMode: () => void;
		onpickSlash: (cmd: SlashCmd) => void;
		onremoveAttachment: (id: string) => void;
		onsetModelChoice: (choice: ModelChoice) => void;
		onopenWorkspaceContext: () => void;
		oncloseAllPopovers: () => void;
	} = $props();

	// Auto-grow the composer textarea with the draft. Resting state is one
	// line (~40px — feels like a real input, not an essay block). Grows
	// smoothly past one line up to roughly half the viewport (capped 480px)
	// then scrolls internally. Audit 2026-05-27 + operator feedback flagged
	// the previous 80px floor as too tall for the empty state.
	$effect(() => {
		const _ = textDraft; // dep — re-run whenever the draft changes
		void _;
		if (!textareaEl) return;
		textareaEl.style.height = 'auto';
		const max = composerMaxHeight();
		const target = Math.min(Math.max(textareaEl.scrollHeight, COMPOSER_MIN_PX), max);
		textareaEl.style.height = `${target}px`;
	});

	// Hidden composer actions (Attach · Image · Dictation) live behind the +,
	// tucked away but one tap from reach (the iOS AI-app convention).
	let actionsOpen = $state(false);
</script>

<!-- Drag-and-drop overlay — appears when the operator drags a file over
     the surface from desktop / Files app. pointer-events-none keeps it
     from intercepting the drop event itself. The drag handlers themselves
     are bound on the parent's outer surface (so the operator can drop
     anywhere on the chat page, not just on the composer pill). -->
{#if isDragging}
	<div
		class="pointer-events-none absolute inset-3 z-[60] flex flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-cyan-400/60 bg-cyan-500/10 backdrop-blur-md"
		aria-hidden="true"
	>
		<Paperclip size={32} class="text-cyan-300" />
		<span class="font-sans text-xs tracking-wider text-cyan-200 uppercase">Drop to attach</span>
		<span class="px-4 text-center font-sans text-xs text-cyan-300/70"
			>Images stage as chips above the composer</span
		>
	</div>
{/if}

<!-- ═════════════════════════════════════════════════════════════════
     HERO COMPOSER PILL
     ═════════════════════════════════════════════════════════════════ -->
<div
	class="relative z-10 shrink-0 px-4 pt-2 pb-4 select-none"
	style="padding-bottom: max(1rem, calc(env(safe-area-inset-bottom, 0px) + 0.75rem));"
>
	<!-- Outer border shifting glow container -->
	<div
		class="relative flex flex-col gap-2 rounded-3xl border p-2 transition-all duration-300
			{composerMode === 'talkback'
			? 'border-emerald-500/40 bg-emerald-500/[0.04] shadow-[0_0_30px_rgba(16,185,129,0.15)]'
			: imageMode
				? 'border-cyan-500/40 bg-cyan-500/[0.04] shadow-[0_0_30px_rgba(6,182,212,0.15)]'
				: sending
					? 'animate-pulse border-[#ec2d78]/45 bg-[#ec2d78]/[0.05] shadow-[0_0_34px_rgba(236,45,120,0.28)]'
					: 'border-white/[0.08] bg-[#0e0e11]/60 backdrop-blur-2xl focus-within:border-white/20'}"
	>
		<!-- Talkback Status indicator inside composer -->
		{#if composerMode === 'talkback'}
			<div
				class="flex items-center justify-between border-b border-white/5 px-2 pt-0.5 pb-1 font-sans text-[10px] select-none"
			>
				<div class="flex items-center gap-1.5">
					<span class="h-2 w-2 animate-ping rounded-full bg-emerald-400"></span>
					<span class="font-semibold text-emerald-400"> 🔊 Walkie-Talkie Engaged </span>
					{#if composerMode === 'talkback' && talkbackPhase}
						<span class="rounded border border-zinc-800 bg-black/40 px-1 text-zinc-500">
							{TALKBACK_PHASE_LABELS[talkbackPhase]}
						</span>
					{/if}
				</div>
				<button
					type="button"
					onclick={onstopTalkback}
					class="rounded-full border border-red-500/30 bg-red-950/20 px-2 py-0.5 text-[9px] tracking-wider text-red-400 uppercase transition-all hover:bg-red-900/30"
				>
					Disconnect
				</button>
			</div>
		{:else if imageMode}
			<div
				class="flex items-center justify-between border-b border-white/5 px-2 pt-0.5 pb-1 font-sans text-[11px] font-medium text-cyan-300 select-none"
			>
				<div class="flex items-center gap-1.5">
					<Sparkles size={12} class="shrink-0 text-cyan-300" />
					<span>Prompt routes to image generation</span>
				</div>
				<button
					type="button"
					onclick={() => (imageMode = false)}
					class="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-0.5 font-sans text-[10px] text-zinc-400 transition-all hover:text-white active:scale-95"
				>
					Cancel
				</button>
			</div>
		{/if}

		<!-- Slash-command autocomplete. Appears when the draft starts with
		     `/` and matches at least one known command. Submit/Send
		     intercepts the literal text and runs the command handler. -->
		{#if slashMode}
			<div
				class="mb-1 flex flex-col gap-1 rounded-2xl border border-cyan-500/20 bg-[#0a1416] p-1.5"
				role="listbox"
				aria-label="Slash commands"
			>
				{#each slashMatches as cmd (cmd.key)}
					<button
						type="button"
						onclick={() => onpickSlash(cmd)}
						class="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-cyan-500/10"
						role="option"
						aria-selected="false"
					>
						<span class="flex flex-col leading-tight">
							<span class="font-sans text-xs text-cyan-300">{cmd.usage}</span>
							<span class="text-[10px] text-zinc-400">{cmd.description}</span>
						</span>
					</button>
				{/each}
			</div>
		{/if}

		<!-- Staged attachments — appear as removable chips with a thumbnail
		     preview, above the text input row. On send, each chip's
		     markdown link is folded into the outgoing message body. -->
		{#if attachments.length > 0}
			<div class="flex flex-wrap gap-2 border-b border-white/5 px-1 pb-2">
				{#each attachments as att (att.id)}
					<div
						class="group relative flex items-center gap-2 rounded-2xl border border-zinc-700 bg-zinc-900 py-1 pr-1 pl-2 text-xs text-zinc-200 shadow-sm"
					>
						<div class="relative h-8 w-8 shrink-0">
							{#if att.mime?.startsWith('image/') && att.url}
								<img
									src={att.url.startsWith('./') ? base + '/' + att.url.slice(2) : att.url}
									alt={att.filename}
									class="h-full w-full rounded-md object-cover"
								/>
							{:else}
								<div
									class="flex h-full w-full items-center justify-center rounded-md bg-zinc-800 text-zinc-500"
								>
									<Paperclip size={14} />
								</div>
							{/if}
							{#if att.uploading}
								<div
									class="absolute inset-0 flex items-center justify-center rounded-md bg-zinc-950/60 backdrop-blur-sm"
								>
									<Loader2 class="animate-spin text-white" size={14} />
								</div>
							{/if}
						</div>
						<div class="flex flex-col leading-tight">
							<span class="max-w-[160px] truncate font-medium text-zinc-200">{att.filename}</span>
							<span class="font-sans text-[10px] text-zinc-500">{humanSize(att.size)}</span>
						</div>
						<button
							type="button"
							onclick={() => onremoveAttachment(att.id)}
							class="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
							aria-label="Remove attachment"
							title="Remove"
						>
							<X size={12} />
						</button>
					</div>
				{/each}
			</div>
		{/if}

		<!-- ─── Workspace-context chip + Model-picker chip ───────────────────
		     Relocated 2026-06-02 from ChatHeader.svelte. Operator rationale:
		     "the button should move where the text area is. since it is
		     closer to the sheet." Mobile sheet anchors to viewport bottom;
		     desktop dropdown blooms UPWARD from the chip via
		     `lg:bottom-full lg:right-0` + transform-origin: bottom right.
		     Both chips share every geometric token (border alpha, blur,
		     rounded-full, h-9 / min-h-[44px]) so they read as a coherent
		     pair. -->
		<div class="flex shrink-0 items-center gap-1.5 px-1 pb-1">
			<!-- Workspace context chip — persistent entry to the Edit Sully's
			     context modal. Single-tap opens the editor. Active state
			     mirrors the model-picker open recipe so both chips glow in
			     the same idiom when their respective surfaces are open. -->
			<button
				type="button"
				onclick={() => {
					oncloseAllPopovers();
					onopenWorkspaceContext();
				}}
				class="flex min-h-[44px] min-w-0 items-center gap-1.5 rounded-full border px-3 font-sans text-xs backdrop-blur-md transition-all active:scale-95 sm:h-9 sm:min-h-0 {workspaceContextOpen
					? 'border-[#ec2d78]/40 bg-[#ec2d78]/10 text-white shadow-[0_0_18px_rgba(236,45,120,0.15)]'
					: 'border-white/[0.07] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08] hover:text-white'}"
				aria-label="Sully's workspace context"
				aria-haspopup="dialog"
				aria-expanded={workspaceContextOpen}
				title="Edit the notes Sully sees on every message"
			>
				<BookOpen
					size={12}
					class={workspaceContextOpen ? 'shrink-0 text-[#ff7eb3]' : 'shrink-0 text-zinc-500'}
					aria-hidden="true"
				/>
				<span
					class="font-sans text-[10px] tracking-wide {workspaceContextOpen
						? 'text-zinc-100'
						: 'text-zinc-400'}">Context</span
				>
			</button>

			<!-- Model picker chip + sheet/dropdown popover.
			     ChevronUp (not Down) because the sheet/dropdown opens ABOVE
			     this chip now; the icon's resting direction signals where
			     tapping will reveal content. Rotates 180° on open to read
			     as a close affordance. -->
			<div class="relative min-w-0">
				<button
					type="button"
					data-popover-trigger
					onclick={() => {
						const next = !showModelOverrideModal;
						oncloseAllPopovers();
						showModelOverrideModal = next;
					}}
					class="flex min-h-[44px] max-w-[8.5rem] min-w-0 items-center gap-1.5 rounded-full border px-3 font-sans text-xs backdrop-blur-md transition-all active:scale-95 sm:h-9 sm:min-h-0 {showModelOverrideModal
						? 'border-[#ec2d78]/40 bg-[#ec2d78]/10 text-white shadow-[0_0_18px_rgba(236,45,120,0.15)]'
						: 'border-white/[0.07] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08] hover:text-white'}"
					aria-label={`${selectedModelChoice.id === 'auto' ? lastModelUsed || 'Auto' : selectedModelChoice.label} — Model picker`}
					title="Pick a specific model or leave on Auto"
				>
					<span class="shrink-0">{tierEmoji}</span>
					<span
						class="min-w-0 truncate font-sans text-[10px] tracking-wide {showModelOverrideModal
							? 'text-zinc-100'
							: 'text-zinc-400'}"
						>{selectedModelChoice.id === 'auto'
							? lastModelUsed || 'Auto'
							: selectedModelChoice.label}</span
					>
					<ChevronUp
						size={10}
						class="shrink-0 transition-transform duration-200 {showModelOverrideModal
							? 'rotate-180 text-[#ff7eb3]'
							: 'text-zinc-500'}"
					/>
				</button>

				{#if showModelOverrideModal}
					<!-- Backdrop scrim — mobile-only visual dim under the sheet.
					     The +page.svelte global popover-close $effect handles
					     tap-to-dismiss because the scrim sits OUTSIDE
					     [data-popover] / [data-popover-trigger]. -->
					<div
						use:mobilePortal
						class="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
						transition:fade={{ duration: 200, easing: cubicOut }}
						aria-hidden="true"
					></div>

					<!-- Below lg: bottom-anchored sheet flush with screen edge.
					     At lg+: dropdown anchored to the chip's TOP-RIGHT and
					     blooming UPWARD (chip is at the composer level so the
					     dropdown opens above to stay on-screen).
					     role=dialog + aria-modal makes the portaled sheet a
					     proper a11y landmark (axe flags portaled-to-body fixed
					     elements as "page content should be contained by
					     landmarks" otherwise). -->
					<div
						use:mobilePortal
						use:swipeToDismiss={{ onDismiss: () => (showModelOverrideModal = false) }}
						data-popover
						role="dialog"
						aria-modal="true"
						aria-label="Choose a model"
						transition:sheetTransition
						class="fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] overflow-y-auto overscroll-contain rounded-t-2xl border border-b-0 border-white/[0.08] bg-[#0e0e11]/85 pt-2 pb-[max(env(safe-area-inset-bottom,0px),0.5rem)] shadow-2xl backdrop-blur-2xl lg:absolute lg:inset-x-auto lg:top-auto lg:bottom-full lg:left-0 lg:mb-2 lg:max-h-[calc(100dvh-6rem)] lg:w-64 lg:max-w-[calc(100vw-1rem)] lg:rounded-2xl lg:border-b lg:pt-1 lg:pb-1"
					>
						<!-- Drag-handle affordance — now functionally wired via
						     use:swipeToDismiss on the parent container. Pull down
						     past 100px from scrollTop=0 to dismiss; below
						     threshold springs back. The handle itself is a visual
						     cue; the gesture works anywhere on the sheet so long
						     as the list is scrolled to the top. -->
						<div
							class="mx-auto mt-1 mb-2 h-1.5 w-10 shrink-0 rounded-full bg-white/20 lg:hidden"
							aria-hidden="true"
						></div>
						<div class="flex items-center justify-between px-3 pt-1.5 pb-0.5 font-sans select-none">
							<span class="text-[9px] tracking-wider text-zinc-600 uppercase">Model</span>
							<button
								type="button"
								onclick={() => (showModelOverrideModal = false)}
								class="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-all hover:bg-white/[0.06] hover:text-zinc-200 active:scale-90"
								aria-label="Close model picker"
								title="Close"
							>
								<X size={14} />
							</button>
						</div>
						{#each MODEL_CHOICES as choice (choice.id)}
							<button
								type="button"
								onclick={() => onsetModelChoice(choice)}
								class="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-1.5 text-left transition-all hover:bg-white/[0.04] active:scale-[0.985] active:bg-white/[0.07]
									{selectedModelChoice.id === choice.id ? 'font-medium text-[#ff7eb3]' : 'text-zinc-200'}"
							>
								<span class="flex min-w-0 flex-col leading-[1.15]">
									<span class="truncate text-[13px]">{choice.label}</span>
									<span class="truncate font-sans text-[10px] text-zinc-500">{choice.sublabel}</span
									>
								</span>
								{#if selectedModelChoice.id === choice.id}
									<Check size={12} class="shrink-0" />
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<!-- Text input area + icons. items-end so buttons sit at the bottom
		     as the textarea grows; min-h on the wrapper preserves the
		     hero-pill height even when the textarea collapses to 1 row. -->
		<div class="flex flex-col gap-2">
			<!-- Row 1: Textarea only (full width) -->
			<div class="w-full">
				<textarea
					bind:this={textareaEl}
					bind:value={textDraft}
					onkeypress={onkey}
					{onpaste}
					{onfocus}
					{onblur}
					rows="1"
					placeholder={composerMode === 'talkback'
						? 'Continuously monitoring stream… hands free.'
						: imageMode
							? 'Describe the image you want to generate…'
							: 'Talk to Sully…'}
					autocomplete="off"
					autocapitalize="sentences"
					spellcheck="false"
					disabled={composerMode === 'talkback'}
					class="w-full resize-none bg-transparent px-1 py-1 font-sans text-[16px] leading-snug tracking-[-0.005em] text-white placeholder:text-zinc-600 focus:outline-none disabled:text-zinc-500"
					style="min-height: 36px; max-height: 480px;"
				></textarea>
			</div>

			<!-- Row 2: + reveals hidden actions (Attach · Image — dictation removed,
			     covered by the voice-mode + talkback buttons). Talkback sits
			     center-right; the magenta voice-mode button anchors the far end and
			     morphs into Send when there's content (iOS AI-app convention). -->
			<div class="flex items-center justify-between gap-2">
				<div class="flex items-center gap-1.5">
					{#if actionsOpen}
						<button
							type="button"
							onclick={() => (actionsOpen = false)}
							class="btn-tactile h-11 w-11 shrink-0 sm:h-9 sm:w-9"
							aria-label="Close actions"
							title="Close"
							in:fly={{ x: -10, duration: 200 }}
						>
							<X size={16} />
						</button>

						<!-- Attach File -->
						<button
							type="button"
							onclick={ontriggerUpload}
							class="btn-tactile h-11 w-11 shrink-0 sm:h-9 sm:w-9"
							aria-label="Attach File"
							title="Attach image"
							in:fly={{ x: -12, duration: 220, delay: 45 }}
						>
							<Paperclip size={15} />
						</button>

						<!-- Sparkles Image Toggle -->
						<button
							type="button"
							onclick={() => (imageMode = !imageMode)}
							disabled={composerMode === 'talkback'}
							class="h-11 w-11 shrink-0 disabled:opacity-40 sm:h-9 sm:w-9 {imageMode
								? 'flex items-center justify-center rounded-[0.8rem] border border-cyan-500/50 bg-cyan-950 text-cyan-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_3px_10px_-3px_rgba(0,0,0,0.55)] transition active:scale-95'
								: 'btn-tactile'}"
							aria-label="Toggle Image Gen Mode"
							title="Image Generation Mode"
							in:fly={{ x: -12, duration: 240, delay: 90 }}
						>
							<Sparkles size={15} />
						</button>
					{:else}
						<!-- + opens the hidden actions -->
						<button
							type="button"
							onclick={() => (actionsOpen = true)}
							class="btn-tactile h-11 w-11 shrink-0 sm:h-9 sm:w-9"
							aria-label="More actions"
							title="Attach · Image"
						>
							<Plus size={18} />
						</button>
					{/if}
				</div>

				<div class="flex items-center gap-1.5">
					<!-- Talkback — hands-free voice while staying in the chat. -->
					<button
						type="button"
						onclick={ontoggleTalkback}
						class="h-11 w-11 shrink-0 disabled:opacity-40 sm:h-9 sm:w-9 {composerMode === 'talkback'
							? 'flex animate-pulse items-center justify-center rounded-[0.8rem] border border-emerald-500/50 bg-emerald-950 text-emerald-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_3px_10px_-3px_rgba(0,0,0,0.55)] transition active:scale-95'
							: 'btn-tactile'}"
						aria-label="Hands-free continuous Talkback"
						title="Talkback — stay in the chat"
					>
						{#if composerMode === 'talkback'}
							<Square size={14} />
						{:else}
							<Headphones size={15} />
						{/if}
					</button>

					<!-- Far end: Send when there's content, else the voice-mode button. -->
					{#if textDraft.trim() || imageMode || attachments.length > 0}
						<button
							type="button"
							onclick={onsend}
							disabled={sending ||
								composerMode === 'talkback' ||
								attachments.some((a) => a.uploading)}
							class="btn-tactile-brand h-11 w-11 shrink-0 sm:h-9 sm:w-9"
							aria-label="Send Message"
							title="Send (Enter)"
						>
							<Send size={14} />
						</button>
					{:else}
						<button
							type="button"
							onclick={onvoiceMode}
							disabled={composerMode === 'talkback'}
							class="btn-tactile-brand h-11 w-11 shrink-0 sm:h-9 sm:w-9"
							aria-label="Voice mode"
							title="Voice mode — talk out loud"
						>
							<AudioLines size={16} />
						</button>
					{/if}
				</div>
			</div>
		</div>
	</div>
</div>
