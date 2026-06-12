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
	import type { Attachment, ComposerMode, TalkbackPhase } from '$lib/types/chat-ui';
	import {
		Send,
		Paperclip,
		Sparkles,
		Square,
		X,
		Loader2,
		AudioLines,
		Mic,
		RefreshCw,
		Plug,
		Flame,
		Repeat
	} from 'lucide-svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	// Icon-wiring pass: UI emoji retired for tintable lucide glyphs (the chat
	// system-message emoji prefixes are NOT touched — those are load-bearing).
	const TALKBACK_PHASE_LABELS: Record<TalkbackPhase, { icon: typeof Plug; text: string }> = {
		connecting: { icon: Plug, text: 'Connecting…' },
		warming: { icon: Flame, text: 'Warming up…' },
		capture: { icon: Mic, text: 'Capture' },
		transcribe: { icon: RefreshCw, text: 'Transcribe' },
		dispatch: { icon: Send, text: 'Sending' },
		speak: { icon: AudioLines, text: 'Reply' },
		loop: { icon: Repeat, text: 'Ready' }
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
		attachments,
		composerMode,
		sending,
		talkbackPhase,
		slashMode,
		slashMatches,
		onsend,
		onabort,
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
		oncloseAllPopovers
	}: {
		textDraft: string;
		imageMode: boolean;
		isDragging: boolean;
		textareaEl: HTMLTextAreaElement | null;
		attachments: Attachment[];
		composerMode: ComposerMode;
		sending: boolean;
		talkbackPhase: TalkbackPhase | null;
		slashMode: boolean;
		slashMatches: SlashCmd[];
		onsend: () => void;
		/** Abort the in-flight stream — wired to the send-slot's stop-button
		 *  when `sending` is true. */
		onabort: () => void;
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
		class="pointer-events-none absolute inset-3 z-[60] flex flex-col items-center justify-center gap-2 rounded-[var(--r-xl)] border-2 border-dashed border-[var(--live-line)] bg-[var(--live-bg)] backdrop-blur-md"
		aria-hidden="true"
	>
		<Paperclip size={32} class="text-[var(--live)]" />
		<span class="font-sans text-xs tracking-wider text-[var(--t1)] uppercase">Drop to attach</span>
		<span class="px-4 text-center font-sans text-xs text-[var(--t3)]"
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
		data-testid="composer-pill"
		class="relative flex flex-col gap-2 rounded-[var(--r-xl)] border p-2 transition-all duration-[var(--dur-slow)]
			{composerMode === 'talkback'
			? 'border-emerald-500/40 bg-emerald-500/[0.04] shadow-[var(--shadow-accent)]'
			: imageMode
				? 'border-[var(--blue-line)] bg-[var(--blue-bg)] shadow-[var(--shadow-accent)]'
				: sending
					? 'composer-sending border-[var(--live-line)] bg-[var(--live-bg)]'
					: 'border-white/[0.08] bg-[#0e0e11]/60 backdrop-blur-2xl focus-within:border-white/20'}"
	>
		<!-- Talkback Status indicator inside composer -->
		{#if composerMode === 'talkback'}
			<div
				class="flex items-center justify-between border-b border-white/5 px-2 pt-0.5 pb-1 font-sans text-[10px] select-none"
			>
				<div class="flex items-center gap-1.5">
					<span class="h-2 w-2 animate-ping rounded-[var(--r-pill)] bg-[var(--green)]"></span>
					<span class="flex items-center gap-1 font-semibold text-[var(--green)]">
						<AudioLines size={11} aria-hidden="true" />
						{talkbackPhase === 'connecting' || talkbackPhase === 'warming'
							? 'Talkback'
							: 'Walkie-Talkie Engaged'}
					</span>
					{#if composerMode === 'talkback' && talkbackPhase}
						{@const phase = TALKBACK_PHASE_LABELS[talkbackPhase]}
						<span
							class="flex items-center gap-1 rounded border border-[var(--line2)] bg-black/40 px-1 text-[var(--t3)]"
						>
							<phase.icon size={10} aria-hidden="true" />
							{phase.text}
						</span>
					{/if}
				</div>
				<!-- No Disconnect during the bring-up window (connecting/warming): there's
				     nothing to disconnect yet, and it resolves to a session or the offline
				     toast within the fast-fail window. The button returns once live. -->
				{#if talkbackPhase !== 'connecting' && talkbackPhase !== 'warming'}
					<button
						type="button"
						onclick={onstopTalkback}
						class="rounded-[var(--r-pill)] border border-red-500/30 bg-red-950/20 px-2 py-0.5 text-[9px] tracking-wider text-red-400 uppercase transition-all hover:bg-red-900/30"
					>
						Disconnect
					</button>
				{/if}
			</div>
		{:else if imageMode}
			<div
				class="flex items-center justify-between border-b border-[var(--line)] px-2 pt-0.5 pb-1 font-sans text-[11px] font-medium text-[var(--blue)] select-none"
			>
				<div class="flex items-center gap-1.5">
					<Sparkles size={12} class="shrink-0 text-[var(--blue)]" />
					<span>Prompt routes to image generation</span>
				</div>
				<button
					type="button"
					onclick={() => (imageMode = false)}
					class="rounded-[var(--r-pill)] border border-white/[0.08] bg-white/[0.04] px-2.5 py-0.5 font-sans text-[10px] text-zinc-400 transition-all hover:text-white active:scale-95"
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
				class="mb-1 flex flex-col gap-1 rounded-[var(--r-lg)] border border-[var(--blue-line)] bg-[var(--bg2)] p-1.5"
				role="listbox"
				aria-label="Slash commands"
			>
				{#each slashMatches as cmd (cmd.key)}
					<button
						type="button"
						onclick={() => onpickSlash(cmd)}
						class="flex w-full items-center justify-between gap-3 rounded-[var(--r-sm)] px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--blue-bg)]"
						role="option"
						aria-selected="false"
					>
						<span class="flex flex-col leading-tight">
							<span class="font-sans text-xs text-[var(--blue)]">{cmd.usage}</span>
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
						class="group relative flex items-center gap-2 rounded-[var(--r-lg)] border border-zinc-700 bg-zinc-900 py-1 pr-1 pl-2 text-xs text-zinc-200 shadow-[var(--shadow-soft)]"
					>
						<div class="relative h-8 w-8 shrink-0">
							{#if att.mime?.startsWith('image/') && att.url}
								<img
									src={att.url.startsWith('./') ? base + '/' + att.url.slice(2) : att.url}
									alt={att.filename}
									class="h-full w-full rounded-[var(--r-xs)] object-cover"
								/>
							{:else}
								<div
									class="flex h-full w-full items-center justify-center rounded-[var(--r-xs)] bg-zinc-800 text-zinc-500"
								>
									<Paperclip size={14} />
								</div>
							{/if}
							{#if att.uploading}
								<div
									class="absolute inset-0 flex items-center justify-center rounded-[var(--r-xs)] bg-zinc-950/60 backdrop-blur-sm"
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
							class="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--r-pill)] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
							aria-label="Remove attachment"
							title="Remove"
						>
							<X size={12} />
						</button>
					</div>
				{/each}
			</div>
		{/if}

		<!-- ─── Single-row composer: [+] textarea [♪] [send|voice] ──────────
		     All secondary buttons are rounded-[var(--r-pill)] circles for visual flow
		     with the brand mic. btn-tactile dropped; flat hover-only
		     treatment. -->
		<div class="relative flex items-end gap-1.5">
			<!-- Left: + button — single slot always. Tapping it opens a popup
			     menu ABOVE the composer (see below) with Attach + Image
			     options. Previously this expanded inline into 3 buttons
			     which crowded the textarea to ~150px on iPhone — text
			     wrapped one word per line. Operator feedback 2026-06-02.
			     The Plus button rotates 45° when open to feel like a
			     toggle, and brightens for affordance. -->
			<button
				type="button"
				data-popover-trigger
				onclick={() => {
					actionsOpen = !actionsOpen;
				}}
				class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--r-pill)] transition-all active:scale-90 sm:h-9 sm:w-9 {actionsOpen
					? 'rotate-45 bg-white/10 text-white'
					: 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'}"
				aria-label="More actions"
				aria-haspopup="menu"
				aria-expanded={actionsOpen}
				title="Attach · Image"
			>
				<Paperclip size={17} />
			</button>

			<!-- Action popup. Anchored to the bottom-left of the composer row
			     so it sits ABOVE the pill, not in the row. Tap-outside is
			     handled by the parent's global popover-close $effect via
			     data-popover/data-popover-trigger. -->
			{#if actionsOpen}
				<div
					data-popover
					role="menu"
					aria-label="Composer actions"
					transition:fly={{ y: 8, duration: 180, easing: cubicOut }}
					class="absolute bottom-full left-0 z-50 mb-2 flex min-w-[10rem] flex-col gap-0.5 rounded-[var(--r-lg)] border border-white/[0.08] bg-[#0e0e11]/95 p-1 shadow-[var(--shadow-float)] backdrop-blur-2xl"
				>
					<button
						type="button"
						role="menuitem"
						onclick={() => {
							actionsOpen = false;
							ontriggerUpload();
						}}
						class="flex items-center gap-2.5 rounded-[var(--r-md)] px-2.5 py-2 text-left text-[13px] text-zinc-200 transition-colors hover:bg-white/[0.06] active:bg-white/[0.1]"
					>
						<Paperclip size={15} class="shrink-0 text-zinc-400" />
						<span>Attach image</span>
					</button>
					<button
						type="button"
						role="menuitem"
						disabled={composerMode === 'talkback'}
						onclick={() => {
							imageMode = !imageMode;
							actionsOpen = false;
						}}
						class="flex items-center gap-2.5 rounded-[var(--r-md)] px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-white/[0.06] active:bg-white/[0.1] disabled:opacity-40 {imageMode
							? 'text-[var(--blue)]'
							: 'text-zinc-200'}"
					>
						<Sparkles
							size={15}
							class="shrink-0 {imageMode ? 'text-[var(--blue)]' : 'text-zinc-400'}"
						/>
						<span>{imageMode ? 'Image mode (on)' : 'Generate image'}</span>
					</button>
				</div>
			{/if}

			<!-- Middle: textarea, takes remaining width -->
			<textarea
				bind:this={textareaEl}
				bind:value={textDraft}
				onkeydown={onkey}
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
				class="min-w-0 flex-1 resize-none self-center bg-transparent px-1 py-2 font-sans text-[16px] leading-snug tracking-[-0.005em] text-white placeholder:text-zinc-600 focus:outline-none disabled:text-zinc-500"
				style="min-height: 36px; max-height: 480px;"
			></textarea>

			<!-- Right: talkback (rounded-[var(--r-pill)] to match) + brand send/voice circle -->
			<button
				type="button"
				onclick={ontoggleTalkback}
				class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--r-pill)] transition-all active:scale-90 disabled:opacity-40 sm:h-9 sm:w-9 {composerMode ===
				'talkback'
					? 'composer-talkback border border-emerald-500/55 bg-emerald-500/10 text-emerald-300'
					: 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'}"
				aria-label="Hands-free continuous Talkback"
				title="Talkback — stay in the chat"
			>
				{#if composerMode === 'talkback'}
					<Square size={14} />
				{:else}
					<AudioLines size={15} />
				{/if}
			</button>

			{#if sending}
				<!-- While a stream is in flight the send slot becomes a STOP button.
				     Tap = abort the SDK stream. Gives the operator a recovery path
				     when the network stalls mid-stream (previously the pulse-fade
				     state just hung indefinitely). The 90s safety timeout in the
				     parent fires the same abort path on its own. -->
				<button
					type="button"
					onclick={onabort}
					class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--r-pill)] border border-red-500/40 bg-red-500/10 text-red-300 transition-all hover:bg-red-500/20 hover:text-red-200 active:scale-90 sm:h-9 sm:w-9"
					aria-label="Stop generating"
					title="Stop generating"
				>
					<Square size={12} fill="currentColor" />
				</button>
			{:else if textDraft.trim() || imageMode || attachments.length > 0}
				<button
					type="button"
					onclick={onsend}
					disabled={composerMode === 'talkback' || attachments.some((a) => a.uploading)}
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
					<Mic size={16} />
				</button>
			{/if}
		</div>
	</div>
</div>
