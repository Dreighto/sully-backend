<script lang="ts">
	// Chat composer pill — textarea + slash-command autocomplete + staged
	// attachment chips + dictation/talkback/image-mode strips + 5 utility
	// buttons (Attach, Sparkles/Image, Mic, Talkback, Send) + the drag-and-drop
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
	// `Voice Dictation`, `Hands-free continuous Talkback`) and tap-target
	// sizes (h-11 w-11 on mobile, sm:h-9 sm:w-9 on desktop) are load-bearing
	// for the chat e2e suite and PR #143's mobile spec. Do not change.

	import { base } from '$app/paths';
	import type { SlashCmd } from '$lib/types/slash';
	import type { Attachment, ComposerMode, TalkbackPhase } from '$lib/types/chat-ui';
	import { Send, Mic, Paperclip, Sparkles, Headphones, Square, X, Loader2 } from 'lucide-svelte';

	const TALKBACK_PHASE_LABELS: Record<TalkbackPhase, string> = {
		capture: '🔴 Capture',
		transcribe: '🔄 Transcribe',
		dispatch: '📤 Sending',
		speak: '🔈 Reply',
		loop: '↩ Ready'
	};

	const COMPOSER_MIN_PX = 40;
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
		onpaste,
		onkey,
		onfocus,
		onblur,
		ontriggerUpload,
		ontoggleRecord,
		ontoggleTalkback,
		onstopTalkback,
		onpickSlash,
		onremoveAttachment
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
		onpaste: (e: ClipboardEvent) => void;
		onkey: (e: KeyboardEvent) => void;
		onfocus: () => void;
		onblur: () => void;
		ontriggerUpload: () => void;
		ontoggleRecord: () => void;
		ontoggleTalkback: () => void;
		onstopTalkback: () => void;
		onpickSlash: (cmd: SlashCmd) => void;
		onremoveAttachment: (id: string) => void;
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
		<span class="font-mono text-xs tracking-wider text-cyan-200 uppercase">Drop to attach</span>
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
			{composerMode === 'recording'
			? 'border-amber-500/40 bg-amber-500/[0.04] shadow-[0_0_30px_rgba(245,158,11,0.15)]'
			: composerMode === 'talkback'
				? 'border-emerald-500/40 bg-emerald-500/[0.04] shadow-[0_0_30px_rgba(16,185,129,0.15)]'
				: imageMode
					? 'border-cyan-500/40 bg-cyan-500/[0.04] shadow-[0_0_30px_rgba(6,182,212,0.15)]'
					: sending
						? 'animate-pulse border-purple-500/40 bg-purple-500/[0.04] shadow-[0_0_30px_rgba(168,85,247,0.15)]'
						: 'border-zinc-800/80 bg-zinc-950/80 shadow-[0_0_24px_rgba(168,85,247,0.06)] focus-within:border-zinc-600/80 hover:border-zinc-700/80'}"
	>
		<!-- Dictation / Talkback Status indicators inside composer -->
		{#if composerMode === 'recording' || composerMode === 'talkback'}
			<div
				class="flex items-center justify-between border-b border-white/5 px-2 pt-0.5 pb-1 font-mono text-[10px] select-none"
			>
				<div class="flex items-center gap-1.5">
					<span
						class="h-2 w-2 animate-ping rounded-full
						{composerMode === 'recording' ? 'bg-amber-400' : 'bg-emerald-400'}"
					></span>
					<span
						class={composerMode === 'recording'
							? 'text-amber-400'
							: 'font-semibold text-emerald-400'}
					>
						{composerMode === 'recording' ? '🔴 Voice Dictation Hot' : '🔊 Walkie-Talkie Engaged'}
					</span>
					{#if composerMode === 'talkback' && talkbackPhase}
						<span class="rounded border border-zinc-800 bg-black/40 px-1 text-zinc-500">
							{TALKBACK_PHASE_LABELS[talkbackPhase]}
						</span>
					{/if}
				</div>
				<button
					type="button"
					onclick={composerMode === 'recording' ? ontoggleRecord : onstopTalkback}
					class="rounded-full border border-red-500/30 bg-red-950/20 px-2 py-0.5 text-[9px] tracking-wider text-red-400 uppercase transition-all hover:bg-red-900/30"
				>
					Disconnect
				</button>
			</div>
		{:else if imageMode}
			<div
				class="flex items-center justify-between border-b border-white/5 px-2 pt-0.5 pb-1 font-mono text-[10px] text-cyan-400 select-none"
			>
				<div class="flex items-center gap-1.5">
					<Sparkles size={11} class="shrink-0 text-cyan-400" />
					<span>✨ Prompt will route to Image Generation</span>
				</div>
				<button
					type="button"
					onclick={() => (imageMode = false)}
					class="rounded-full border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[9px] tracking-wider text-zinc-400 uppercase transition-all hover:text-white"
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
							<span class="font-mono text-xs text-cyan-300">{cmd.usage}</span>
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
							<span class="font-mono text-[10px] text-zinc-500">{humanSize(att.size)}</span>
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
					placeholder={composerMode === 'recording'
						? 'Listening dictation… press stop when done.'
						: composerMode === 'talkback'
							? 'Continuously monitoring stream… hands free.'
							: imageMode
								? 'Describe the image you want to generate…'
								: 'Ask or command loops…'}
					autocomplete="off"
					autocapitalize="sentences"
					spellcheck="false"
					disabled={composerMode === 'recording' || composerMode === 'talkback'}
					class="w-full resize-none bg-transparent px-1 py-1 font-sans text-[16px] leading-snug tracking-[-0.005em] text-white placeholder:text-zinc-600 focus:outline-none disabled:text-zinc-500"
					style="min-height: 40px; max-height: 480px;"
				></textarea>
			</div>

			<!-- Row 2: Utility buttons left, Send button right -->
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-1.5">
					<!-- Attach File -->
					<button
						type="button"
						onclick={ontriggerUpload}
						class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-800/80 bg-zinc-900 text-zinc-400 transition-colors hover:text-white active:scale-90 sm:h-9 sm:w-9"
						aria-label="Attach File"
						title="Attach image"
					>
						<Paperclip size={15} />
					</button>

					<!-- Sparkles Image Toggle -->
					<button
						type="button"
						onclick={() => (imageMode = !imageMode)}
						disabled={composerMode === 'recording' || composerMode === 'talkback'}
						class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-all active:scale-90 disabled:opacity-40 sm:h-9 sm:w-9
							{imageMode
							? 'border border-cyan-500/50 bg-cyan-950 text-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.2)]'
							: 'border border-zinc-800/80 bg-zinc-900 text-zinc-400 hover:text-white'}"
						aria-label="Toggle Image Gen Mode"
						title="Image Generation Mode"
					>
						<Sparkles size={15} />
					</button>

					<!-- Voice Dictation Mic -->
					<button
						type="button"
						onclick={ontoggleRecord}
						disabled={composerMode === 'talkback'}
						class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-all active:scale-90 disabled:opacity-40 sm:h-9 sm:w-9
							{composerMode === 'recording'
							? 'animate-pulse border border-amber-500/50 bg-amber-950 text-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.2)]'
							: 'border border-zinc-800/80 bg-zinc-900 text-zinc-400 hover:text-white'}"
						aria-label={composerMode === 'recording' ? 'Stop Recording' : 'Voice Dictation'}
						title={composerMode === 'recording' ? 'Stop Recording' : 'Voice Dictation'}
					>
						{#if composerMode === 'recording'}
							<Square size={14} />
						{:else}
							<Mic size={15} />
						{/if}
					</button>

					<!-- Talkback Continuous -->
					<button
						type="button"
						onclick={ontoggleTalkback}
						disabled={composerMode === 'recording'}
						class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-all active:scale-90 disabled:opacity-40 sm:h-9 sm:w-9
							{composerMode === 'talkback'
							? 'animate-pulse border border-emerald-500/50 bg-emerald-950 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
							: 'border border-zinc-800/80 bg-zinc-900 text-zinc-400 hover:text-white'}"
						aria-label="Hands-free continuous Talkback"
						title="Hands-free continuous Talkback"
					>
						{#if composerMode === 'talkback'}
							<Square size={14} />
						{:else}
							<Headphones size={15} />
						{/if}
					</button>
				</div>

				<!-- Send Button -->
				<button
					type="button"
					onclick={onsend}
					disabled={(!textDraft.trim() && !imageMode && attachments.length === 0) ||
						sending ||
						composerMode === 'recording' ||
						composerMode === 'talkback' ||
						attachments.some((a) => a.uploading)}
					class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 text-white shadow-lg transition-all hover:scale-105 active:scale-95 disabled:scale-100 disabled:border disabled:border-zinc-800 disabled:from-zinc-900 disabled:to-zinc-900 disabled:text-zinc-600 disabled:shadow-none sm:h-9 sm:w-9"
					aria-label="Send Message"
					title="Send (Enter)"
					style={textDraft.trim() && !sending && composerMode === 'idle'
						? 'box-shadow: 0 0 12px rgba(168, 85, 247, 0.35);'
						: ''}
				>
					<Send size={14} />
				</button>
			</div>
		</div>
	</div>
</div>
