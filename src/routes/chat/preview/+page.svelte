<script lang="ts">
	// /chat/preview — SDK-native chat surface (PR 2a of the SDK adoption track).
	//
	// This is the side-by-side preview of the chat experience built directly on
	// `@ai-sdk/svelte`'s `Chat` class + the /api/chat/sdk-stream endpoint.
	//
	// What's intentionally NOT here (yet — comes in later PRs):
	//   - Thread sidebar / thread switching   (PR 2b)
	//   - Image attachments / image-gen mode   (PR 4)
	//   - Voice dictation / talkback           (PR 4)
	//   - @cc / @agy dispatch tokens           (PR 3)
	//   - Slash commands                       (PR 3)
	//   - Persistence to logueos_memory.db     (PR 2b)
	//
	// Lives at /companion/chat/preview. The main /companion/chat surface is
	// untouched. Operator can A/B by switching URLs on their phone.
	// After validation, PR 2b copies this implementation back into /chat
	// replacing the legacy custom-streaming code, and deletes the preview.

	import { Chat } from '@ai-sdk/svelte';
	import { DefaultChatTransport } from 'ai';
	import { resolve } from '$app/paths';
	import { Send, ArrowLeft, Sparkles, AlertTriangle } from 'lucide-svelte';

	type Provider = 'anthropic' | 'google';

	let input = $state('');
	let provider = $state<Provider>('anthropic');
	let feedContainer = $state<HTMLElement | null>(null);
	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let scrollSentinel = $state<HTMLDivElement | null>(null);

	function scrollFeedToBottom(behavior: ScrollBehavior = 'smooth') {
		if (!feedContainer) return;
		feedContainer.scrollTo({ top: feedContainer.scrollHeight, behavior });
	}

	// SDK 6 Chat class does NOT accept `api`/`body` shorthand at the top
	// level — those keys are silently ignored. Use DefaultChatTransport.
	const chat = new Chat({
		transport: new DefaultChatTransport({
			api: resolve('/api/chat/sdk-stream'),
			body: () => ({ provider })
		})
	});

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		const text = input.trim();
		if (!text) return;
		chat.sendMessage({ text });
		input = '';
		queueMicrotask(() => scrollFeedToBottom('smooth'));
	}

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			const text = input.trim();
			if (!text) return;
			chat.sendMessage({ text });
			input = '';
			queueMicrotask(() => scrollFeedToBottom('smooth'));
		}
	}

	// Auto-grow the composer textarea with the draft. Resting state is one
	// line (~40px — feels like a real input, not an essay). Grows up to
	// ~480px before scrolling internally; matches mobile messaging defaults.
	const COMPOSER_MIN_PX = 40;
	const COMPOSER_MAX_PX = 480;
	$effect(() => {
		const _ = input;
		void _;
		if (!textareaEl) return;
		textareaEl.style.height = 'auto';
		const target = Math.min(Math.max(textareaEl.scrollHeight, COMPOSER_MIN_PX), COMPOSER_MAX_PX);
		textareaEl.style.height = `${target}px`;
	});

	// Auto-scroll to bottom when a new message lands.
	$effect(() => {
		const _ = chat.messages.length;
		void _;
		queueMicrotask(() => scrollFeedToBottom('smooth'));
	});
</script>

<svelte:head>
	<title>SDK Preview · Companion</title>
</svelte:head>

<div class="relative flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-background text-white">
	<!-- Radial atmosphere -->
	<div
		class="pointer-events-none absolute inset-0 -z-0"
		style="background: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(168, 85, 247, 0.07), transparent 60%), radial-gradient(ellipse 60% 50% at 100% 100%, rgba(244, 114, 182, 0.04), transparent 50%);"
	></div>

	<!-- Header -->
	<header
		class="relative z-10 flex shrink-0 items-center justify-between px-4 pt-3 pb-2 select-none"
		style="padding-top: max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem));"
	>
		<a
			href={resolve('/chat')}
			class="flex h-9 items-center gap-1.5 rounded-[var(--r-md)] border border-zinc-800/80 bg-zinc-950/60 px-3 text-xs text-zinc-400 transition-all hover:text-white active:scale-95"
			aria-label="Back to live chat"
		>
			<ArrowLeft size={14} aria-hidden="true" />
			<span>Live chat</span>
		</a>

		<div
			class="flex items-center gap-1.5 rounded-[var(--r-pill)] border border-purple-500/40 bg-purple-500/[0.04] px-3 py-1.5 font-mono text-[10px] tracking-wider text-purple-300 uppercase"
			data-testid="sdk-preview-badge"
		>
			<Sparkles size={11} aria-hidden="true" />
			<span>SDK preview</span>
		</div>

		<div class="flex items-center gap-1">
			<button
				type="button"
				onclick={() => (provider = provider === 'anthropic' ? 'google' : 'anthropic')}
				class="flex h-9 items-center gap-1.5 rounded-[var(--r-pill)] border border-zinc-800 bg-[#0e0e0e] px-3 font-mono text-[10px] tracking-wide text-zinc-300 transition-all hover:border-zinc-700 hover:text-white active:scale-95"
				aria-label="Toggle provider"
				data-testid="provider-toggle"
			>
				<span>{provider === 'anthropic' ? '🧠' : '✨'}</span>
				<span>{provider === 'anthropic' ? 'Claude' : 'Gemini'}</span>
			</button>
		</div>
	</header>

	<!-- Feed -->
	<main
		bind:this={feedContainer}
		class="relative z-10 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-3"
	>
		{#if chat.messages.length === 0 && chat.status !== 'error'}
			<div class="flex flex-1 flex-col items-center justify-center gap-2 text-center select-none">
				<div class="font-mono text-[11px] tracking-wider text-zinc-500 uppercase">
					SDK preview · ready
				</div>
				<div class="max-w-xs text-sm text-zinc-600">
					Talk to the operator's planning partner over the new SDK transport.
				</div>
			</div>
		{:else}
			{#each chat.messages as message (message.id)}
				<div
					class="flex flex-col gap-1 {message.role === 'user' ? 'items-end' : 'items-start'}"
					data-testid="msg-{message.role}"
				>
					{#if message.role !== 'user'}
						<div
							class="mb-1.5 flex w-fit items-center gap-1 rounded-[var(--r-pill)] border border-cyan-500/20 bg-cyan-950/20 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-cyan-400 uppercase select-none"
						>
							<Sparkles size={10} class="shrink-0 text-cyan-400" aria-hidden="true" />
							<span>{provider === 'anthropic' ? 'CLAUDE' : 'GEMINI'}</span>
						</div>
					{/if}
					<div
						class="max-w-[85%] rounded-[var(--r-lg)] px-3.5 py-2 font-sans text-[13.5px] leading-snug tracking-[-0.005em] antialiased sm:max-w-[80%]
							{message.role === 'user'
							? 'border border-orange-500/30 bg-orange-500/[0.03] text-orange-50 shadow-[var(--shadow-soft)]'
							: 'border border-zinc-900 bg-zinc-950/40 text-zinc-100'}"
					>
						{#each message.parts as part, i (i)}
							{#if part.type === 'text'}
								<span class="whitespace-pre-wrap">{part.text}</span>
							{:else if part.type?.startsWith('tool-')}
								<!-- Tool-call chip: shows what the LLM is doing on the
								     operator's behalf. PR 10a renders a compact one-liner
								     per state — later PRs can expand to show args/output
								     inline and add an approval gate for write-tools. -->
								<div
									class="my-1 flex flex-col gap-0.5 rounded-[var(--r-sm)] border border-purple-500/30 bg-purple-500/[0.04] px-2.5 py-1.5 font-mono text-[11px]"
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
				</div>
			{/each}
		{/if}

		{#if chat.status === 'error'}
			<!-- Error notice — appears inline below the messages so the operator's
			     send isn't lost from view. The next send transitions chat.status
			     back to 'submitted'/'streaming' so this notice is transient by
			     design — sending again retries. -->
			<div
				class="flex items-start gap-2.5 rounded-[var(--r-lg)] border border-red-500/30 bg-red-500/[0.04] px-3.5 py-2.5"
				data-testid="error-state"
			>
				<AlertTriangle size={14} class="mt-0.5 shrink-0 text-red-400" aria-hidden="true" />
				<div class="flex flex-col gap-0.5">
					<div class="font-mono text-[10px] tracking-wider text-red-400 uppercase">
						Stream failed
					</div>
					<div class="text-[12px] text-zinc-400">
						Send again to retry. Check provider credentials if it keeps failing.
					</div>
				</div>
			</div>
		{/if}

		<div bind:this={scrollSentinel} class="h-0 w-full shrink-0"></div>
	</main>

	<!-- Composer -->
	<div
		class="relative z-10 shrink-0 px-3 pt-2 pb-3"
		style="padding-bottom: max(0.75rem, calc(env(safe-area-inset-bottom, 0px) + 0.5rem));"
	>
		<form
			onsubmit={handleSubmit}
			class="flex flex-col gap-2 rounded-[var(--r-xl)] border border-zinc-800/80 bg-zinc-950/80 p-2.5 shadow-[var(--shadow-card)] backdrop-blur-xl"
		>
			<textarea
				bind:this={textareaEl}
				bind:value={input}
				onkeypress={handleKey}
				rows="1"
				placeholder={chat.status === 'error'
					? 'Last send failed — try again'
					: chat.status === 'streaming'
						? 'Streaming reply…'
						: 'Ask the SDK preview…'}
				autocomplete="off"
				autocapitalize="sentences"
				spellcheck="false"
				disabled={chat.status === 'streaming' || chat.status === 'submitted'}
				class="w-full resize-none bg-transparent px-1 py-1 font-sans text-[16px] leading-snug tracking-[-0.005em] text-white placeholder:text-zinc-600 focus:outline-none disabled:text-zinc-500"
				style="min-height: 40px; max-height: 480px;"
				data-testid="composer"
			></textarea>

			<div class="flex items-center justify-between">
				<div
					class="font-mono text-[9px] tracking-wider uppercase select-none {chat.status === 'error'
						? 'text-red-400'
						: 'text-zinc-600'}"
				>
					{chat.status === 'streaming'
						? '· streaming ·'
						: chat.status === 'submitted'
							? '· submitted ·'
							: chat.status === 'error'
								? '· error · retry to send ·'
								: 'enter to send'}
				</div>

				<button
					type="submit"
					disabled={!input.trim() || chat.status === 'streaming' || chat.status === 'submitted'}
					class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--r-md)] bg-gradient-to-br from-purple-500 to-pink-500 text-white shadow-[var(--shadow-card)] transition-all hover:scale-105 active:scale-95 disabled:scale-100 disabled:border disabled:border-zinc-800 disabled:from-zinc-900 disabled:to-zinc-900 disabled:text-zinc-600 disabled:shadow-none"
					aria-label="Send Message"
					data-testid="send-button"
				>
					<Send size={14} aria-hidden="true" />
				</button>
			</div>
		</form>
	</div>
</div>
