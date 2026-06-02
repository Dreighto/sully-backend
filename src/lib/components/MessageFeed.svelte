<script lang="ts">
	// Scrolling message-list region — extracted from chat/+page.svelte.
	// Renders the entire `{#each messages}` block (operator pills + assistant
	// flat replies via <Markdown> + the per-message action footer + timestamps
	// + the per-message WorkingBubble for system sully-* rows), the thinking-dots
	// indicator, the live tool-call rows, the scroll sentinel, and the
	// "{n} new messages ↓" chip.
	//
	// Behavior + appearance are byte-for-byte identical to the inline original:
	// every data-testid, aria-label, conditional, and SullyAvatar usage is
	// preserved. The scroll sentinel element is exposed back to the page via a
	// $bindable so the page's IntersectionObserver (in onMount) keeps working
	// unchanged — the page owns the observer + userAtBottom state.
	//
	// `messages` stays page-owned; this component receives it read-only and emits
	// all actions (copy / regenerate / read-aloud / scroll-to-bottom / open-canvas)
	// back via callback props.

	import { base } from '$app/paths';
	import WorkingBubble from '$lib/components/WorkingBubble.svelte';
	import SullyAvatar from '$lib/components/SullyAvatar.svelte';
	import SullyNameTag from '$lib/components/SullyNameTag.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import {
		Sparkles,
		Check,
		Copy,
		RefreshCw,
		Volume2,
		Square,
		Loader2,
		ThumbsUp,
		ThumbsDown
	} from 'lucide-svelte';
	import type { ChatMessage } from '$lib/types/chat-ui';
	import type { Chat } from '@ai-sdk/svelte';

	type StreamState = { placeholderId: number; threadId: string } | null;
	type AppIdentity = { coreLabel?: string } | null | undefined;

	let {
		messages,
		streamState,
		sdkChat,
		hasActiveToolCalls,
		appIdentity,
		copiedIds,
		regeneratingIds,
		speakingId,
		speakLoadingId,
		sending,
		scrollSentinel = $bindable(null),
		oncopy,
		onregenerate,
		onspeak,
		onfeedback,
		openCanvas,
		onimagepreview,
		ensureDispatchStream,
		fmtTime,
		parseDbTimestamp
	}: {
		messages: ChatMessage[];
		streamState: StreamState;
		sdkChat: Chat;
		hasActiveToolCalls: boolean;
		appIdentity: AppIdentity;
		copiedIds: Set<number>;
		regeneratingIds: Set<number>;
		speakingId: number | null;
		speakLoadingId: number | null;
		sending: boolean;
		scrollSentinel?: HTMLDivElement | null;
		oncopy: (m: ChatMessage) => void;
		onregenerate: (m: ChatMessage) => void;
		onspeak: (m: ChatMessage) => void;
		onfeedback: (m: ChatMessage, signal: 1 | -1 | 0) => void;
		openCanvas: (code: string, language: string) => void;
		/** Tap-to-preview on any inline image — opens the lightbox at +page.svelte. */
		onimagepreview: (src: string, alt: string) => void;
		ensureDispatchStream: (
			traceId: string
		) => ReturnType<typeof import('$lib/chat/dispatchStream.svelte').createDispatchStream>;
		fmtTime: (iso: string) => string;
		parseDbTimestamp: (iso: string) => Date | null;
	} = $props();

	// Friendly labels for the tool-call chips shown while Sully works, instead of
	// raw tool ids like "web_search".
	function toolLabel(type: string): string {
		const name = (type || '').replace(/^tool-/, '');
		const map: Record<string, string> = {
			web_search: 'Searching the web',
			web_fetch: 'Reading a page',
			read_file: 'Reading a file',
			list_directory: 'Browsing files',
			deep_think: 'Thinking it through',
			consult_claude: 'Consulting Claude',
			list_chat_threads: 'Checking your threads',
			read_thread_messages: 'Recalling the conversation',
			get_server_status: 'Checking the system'
		};
		return map[name] ?? name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	}
</script>

{#if messages.length === 0}
	<div class="flex flex-1 items-center justify-center text-center select-none">
		<div class="flex max-w-xs flex-col items-center gap-3">
			<img
				src="{base}/sully-mark.png"
				alt="Sully"
				class="h-16 w-16 drop-shadow-[0_0_22px_rgba(236,45,120,0.5)]"
			/>
			<div class="font-sans text-base text-zinc-200">Hey Captain — what's on your mind?</div>
			<div class="font-sans text-xs text-zinc-500">Sully's here. Think out loud.</div>
		</div>
	</div>
{:else}
	{#each messages as m (m.id)}
		<!-- Skip rendering the empty stream-placeholder bubble while the
		     thinking-dots block represents it. Once any token text
		     arrives, m.message is non-empty and the bubble re-renders. -->
		{#if !(streamState?.placeholderId === m.id && m.message === '')}
			<div class="flex flex-col gap-1 {m.sender === 'operator' ? 'items-end' : 'items-start'}">
				<!-- Custom Labeling / Bubble Headers -->
				{#if m.sender !== 'operator'}
					<SullyNameTag
						label={m.sender === 'system' ? 'LOGUEOS' : (appIdentity?.coreLabel ?? 'Sully')}
					/>
				{/if}

				<!-- Text Bubble. Operator bubbles render raw (whitespace-pre)
			     since they're literally what was typed. Assistant
			     bubbles render through the Markdown component for
			     code-block highlighting, inline code, lists, etc. -->
				<div
					class="font-sans text-[14px] leading-relaxed tracking-[-0.005em] antialiased selection:bg-brand/40 selection:text-white
									{m.sender === 'operator'
						? 'max-w-[85%] rounded-2xl border border-zinc-700/60 bg-zinc-900/60 px-3.5 py-2 text-zinc-100 sm:max-w-[80%]'
						: 'w-full px-0.5 text-zinc-100/95'}"
				>
					{#if m.sender === 'operator'}
						<span class="whitespace-pre-wrap">{m.message}</span>
					{:else}
						<Markdown content={m.message} oncanvas={openCanvas} {onimagepreview} />
					{/if}
				</div>

				<!-- Time + actions footer. Copy + Regenerate on assistant
			     replies only — operator's own bubbles already echo
			     their input and can't be re-rolled. -->
				<div class="flex items-center gap-2 px-1 select-none">
					{#if m.sender !== 'operator' && m.message}
						<button
							type="button"
							onclick={() => oncopy(m)}
							class="flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 font-sans text-[11px] font-medium text-zinc-500 transition-all hover:bg-white/[0.06] hover:text-zinc-200 active:scale-95 sm:min-h-0"
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
							onclick={() => onregenerate(m)}
							disabled={sending || regeneratingIds.has(m.id)}
							class="flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 font-sans text-[11px] font-medium text-zinc-500 transition-all hover:bg-white/[0.06] hover:text-zinc-200 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
							aria-label={regeneratingIds.has(m.id)
								? 'Regen… — Regenerate reply'
								: 'Regen — Regenerate reply'}
							title={regeneratingIds.has(m.id) ? 'Regenerating…' : 'Regenerate reply'}
						>
							<RefreshCw size={10} class={regeneratingIds.has(m.id) ? 'animate-spin' : ''} />
							<span>{regeneratingIds.has(m.id) ? 'Regen…' : 'Regen'}</span>
						</button>
						<button
							type="button"
							onclick={() => onspeak(m)}
							class="flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 font-sans text-[11px] font-medium transition-all hover:bg-white/[0.06] active:scale-95 sm:min-h-0 {speakingId ===
							m.id
								? 'text-brand-soft'
								: 'text-zinc-500 hover:text-zinc-200'}"
							aria-label={speakLoadingId === m.id
								? '… — Read aloud (loading)'
								: speakingId === m.id
									? 'Stop — Read aloud'
									: 'Play — Read aloud'}
							title={speakingId === m.id
								? 'Stop'
								: speakLoadingId === m.id
									? 'Loading…'
									: 'Read aloud'}
						>
							{#if speakLoadingId === m.id}
								<Loader2 size={10} class="animate-spin" />
								<span>…</span>
							{:else if speakingId === m.id}
								<Square size={10} />
								<span>Stop</span>
							{:else}
								<Volume2 size={10} />
								<span>Play</span>
							{/if}
						</button>
						<!-- Explicit feedback: thumbs-up / thumbs-down on assistant
						     replies. Toggles on/off — clicking the active signal
						     clears it (passes 0). Captured in chat_messages.quality_signal
						     so the fine-tune extractor can harvest explicit
						     positives alongside the implicit ones it already pulls. -->
						<button
							type="button"
							onclick={() => onfeedback(m, m.quality_signal === 1 ? 0 : 1)}
							class="flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 font-sans text-[11px] font-medium transition-all hover:bg-white/[0.06] active:scale-95 sm:min-h-0 {m.quality_signal ===
							1
								? 'text-emerald-400'
								: 'text-zinc-500 hover:text-zinc-200'}"
							aria-label={m.quality_signal === 1 ? 'Remove thumbs-up' : 'Thumbs-up reply'}
							aria-pressed={m.quality_signal === 1}
							title={m.quality_signal === 1 ? 'Liked — click to undo' : 'Good reply'}
							data-testid="feedback-up"
						>
							<ThumbsUp size={10} />
						</button>
						<button
							type="button"
							onclick={() => onfeedback(m, m.quality_signal === -1 ? 0 : -1)}
							class="flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 font-sans text-[11px] font-medium transition-all hover:bg-white/[0.06] active:scale-95 sm:min-h-0 {m.quality_signal ===
							-1
								? 'text-rose-400'
								: 'text-zinc-500 hover:text-zinc-200'}"
							aria-label={m.quality_signal === -1 ? 'Remove thumbs-down' : 'Thumbs-down reply'}
							aria-pressed={m.quality_signal === -1}
							title={m.quality_signal === -1 ? 'Disliked — click to undo' : 'Bad reply'}
							data-testid="feedback-down"
						>
							<ThumbsDown size={10} />
						</button>
					{/if}
					<div class="font-sans text-[10px] text-zinc-600 tabular-nums">
						{fmtTime(m.timestamp)}
					</div>
				</div>
			</div>
			{#if m.sender === 'system' && m.trace_id?.startsWith('sully-')}
				{@const ctrl = ensureDispatchStream(m.trace_id)}
				<WorkingBubble
					worker={m.trace_id.includes('agy') ? 'gemini' : 'claude-code'}
					rows={ctrl.rows}
					status={ctrl.status}
					resultRef={ctrl.resultRef}
					startedAt={parseDbTimestamp(m.timestamp)?.getTime() ?? Date.now()}
				/>
			{/if}
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
	{#if streamState && !hasActiveToolCalls && messages.find((m) => m.id === streamState!.placeholderId)?.message === ''}
		<div class="flex flex-col items-start gap-1">
			<SullyNameTag label={appIdentity?.coreLabel ?? 'Sully'} />
			<div
				class="flex items-center gap-2.5 rounded-2xl border border-[#ec2d78]/20 bg-[#ec2d78]/[0.06] py-2 pr-4 pl-2.5"
				aria-label="Sully is thinking"
				role="status"
			>
				<!-- Tiny working monster — a living cue that Sully is busy, not
				     hung. The sprite's own 'thinking' sway provides the motion. -->
				<SullyAvatar state="thinking" size={34} glow={false} />
				<div class="flex items-center gap-1.5">
					<span
						class="h-1.5 w-1.5 animate-bounce rounded-full bg-[#ec2d78]"
						style="animation-delay: 0ms"
					></span>
					<span
						class="h-1.5 w-1.5 animate-bounce rounded-full bg-[#ec2d78]"
						style="animation-delay: 150ms"
					></span>
					<span
						class="h-1.5 w-1.5 animate-bounce rounded-full bg-[#ec2d78]"
						style="animation-delay: 300ms"
					></span>
				</div>
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
				<!-- ● Sully name-tag — matches the thinking indicator so tool work
				     reads as Sully working, not a bare system chip. -->
				<SullyNameTag label={appIdentity?.coreLabel ?? 'Sully'} />
				<div class="flex items-start gap-2.5">
					<!-- Working monster — a living cue that Sully is on the tools. -->
					<SullyAvatar state="working" size={34} glow={false} />
					<div class="flex flex-col gap-1">
						{#each sdkMsg.parts as part, i (i)}
							{#if part.type?.startsWith('tool-')}
								<div
									class="flex flex-col gap-0.5 rounded-lg border border-brand/25 bg-brand/[0.05] px-2.5 py-1.5 font-sans text-[11px]"
								>
									<div class="flex items-center gap-1.5 text-brand-soft">
										<Sparkles size={11} aria-hidden="true" />
										<span class="font-semibold tracking-wide">
											{toolLabel(part.type)}
										</span>
										<span class="ml-auto text-[9px] tracking-wider text-brand-soft/60 uppercase">
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
				</div>
			</div>
		{/if}
	{/each}
{/if}

<div bind:this={scrollSentinel} class="h-px shrink-0" aria-hidden="true"></div>
