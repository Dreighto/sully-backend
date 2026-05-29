<script lang="ts">
	// Immersive full-screen Voice Mode overlay. Renders the realtime voice
	// controller's state: a phase-reactive orb, the operator's live transcript,
	// the companion's streaming reply (toggleable), and a press-and-hold
	// push-to-talk button. All audio/STT/TTS logic lives in the controller
	// ($lib/chat/realtime-voice.svelte.ts); this component is pure presentation +
	// gesture wiring.

	import { Mic, X, Captions, CaptionsOff, Loader2, AudioLines, AlertCircle } from 'lucide-svelte';
	import type { RealtimeVoiceController } from '$lib/chat/realtime-voice.svelte';
	import type { VoicePhase } from '$lib/types/chat-ui';

	let { voice }: { voice: RealtimeVoiceController } = $props();

	const PHASE_LABEL: Record<VoicePhase, string> = {
		connecting: 'Waking the voice…',
		idle: 'Hold to talk',
		listening: 'Listening…',
		thinking: 'Thinking…',
		speaking: 'Speaking — hold to interrupt',
		error: 'Something went wrong'
	};

	// iOS suspends AudioContexts when the tab/PWA backgrounds; resume on return.
	$effect(() => {
		const onVisible = () => {
			if (document.visibilityState === 'visible') voice.resumeAudio();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	});

	// Escape closes Voice Mode.
	$effect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') void voice.exit();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	// Push-to-talk gesture. Pointer events cover mouse + touch; we suppress the
	// default so a long touch-press doesn't select text or fire the context menu.
	function onPressDown(e: PointerEvent) {
		e.preventDefault();
		void voice.pressStart();
	}
	function onPressUp(e: PointerEvent) {
		e.preventDefault();
		voice.pressEnd();
	}

	const isError = $derived(voice.phase === 'error');
	const isConnecting = $derived(voice.phase === 'connecting');
	const pttDisabled = $derived(isConnecting || isError);

	// Phase-reactive orb colors (derived class strings — Svelte class directives
	// can't carry Tailwind's `/opacity` slash syntax, so we compute them here).
	const haloClass = $derived(
		voice.phase === 'listening'
			? 'bg-orange-500 opacity-20 animate-ping'
			: voice.phase === 'speaking'
				? 'bg-sky-500 opacity-20 animate-ping'
				: voice.phase === 'thinking'
					? 'bg-zinc-600 opacity-20'
					: 'bg-zinc-600 opacity-10'
	);
	const coreClass = $derived(
		voice.phase === 'listening'
			? 'bg-orange-500'
			: voice.phase === 'speaking'
				? 'bg-sky-500'
				: voice.phase === 'thinking'
					? 'bg-zinc-700/70'
					: 'bg-zinc-700'
	);
</script>

{#if voice.open}
	<div
		class="fixed inset-0 z-[100] flex flex-col bg-zinc-950/95 backdrop-blur-xl text-zinc-100"
		role="dialog"
		aria-modal="true"
		aria-label="Voice mode"
	>
		<!-- Header -->
		<div class="flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
			<div class="flex items-center gap-2 text-sm font-medium text-zinc-400">
				<AudioLines size={16} class="text-orange-400" />
				<span>Voice</span>
			</div>
			<div class="flex items-center gap-1">
				<button
					type="button"
					onclick={() => voice.toggleCaptions()}
					class="flex h-10 w-10 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
					aria-label={voice.captions ? 'Hide captions (voice only)' : 'Show captions'}
					title={voice.captions ? 'Hide captions (voice only)' : 'Show captions'}
				>
					{#if voice.captions}
						<Captions size={20} />
					{:else}
						<CaptionsOff size={20} />
					{/if}
				</button>
				<button
					type="button"
					onclick={() => void voice.exit()}
					class="flex h-10 w-10 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
					aria-label="Close voice mode"
					title="Close voice mode"
				>
					<X size={22} />
				</button>
			</div>
		</div>

		<!-- Transcript region -->
		<div class="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-4">
			{#if isError}
				<div class="flex max-w-md flex-col items-center gap-3 text-center">
					<AlertCircle size={40} class="text-red-400" />
					<p class="text-base text-zinc-200">{voice.errorMsg ?? 'Voice mode error.'}</p>
					<button
						type="button"
						onclick={() => void voice.exit()}
						class="mt-1 rounded-full bg-zinc-800 px-5 py-2 text-sm font-medium text-zinc-100 transition hover:bg-zinc-700"
					>
						Close
					</button>
				</div>
			{:else}
				<!-- Phase orb -->
				<div class="relative flex h-32 w-32 items-center justify-center">
					<div class="absolute inset-0 rounded-full transition-all duration-500 {haloClass}"></div>
					<div
						class="relative flex h-24 w-24 items-center justify-center rounded-full transition-all duration-300 {coreClass}"
					>
						{#if voice.phase === 'thinking' || isConnecting}
							<Loader2 size={32} class="animate-spin text-zinc-200" />
						{:else if voice.phase === 'speaking'}
							<AudioLines size={32} class="text-white" />
						{:else}
							<Mic size={32} class="text-zinc-100" />
						{/if}
					</div>
				</div>

				<!-- Operator's live / final utterance -->
				<div class="min-h-[2rem] max-w-2xl text-center text-lg font-medium text-zinc-100">
					{voice.partial || voice.userText}
				</div>

				<!-- Companion reply (captions) -->
				{#if voice.captions && voice.replyText}
					<div
						class="max-h-[40vh] max-w-2xl overflow-y-auto whitespace-pre-wrap rounded-2xl bg-zinc-900/70 px-5 py-4 text-center text-base leading-relaxed text-zinc-300"
					>
						{voice.replyText}
					</div>
				{/if}
			{/if}
		</div>

		<!-- Push-to-talk -->
		{#if !isError}
			<div class="flex flex-col items-center gap-3 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2">
				<p class="text-sm text-zinc-400">{PHASE_LABEL[voice.phase]}</p>
				<button
					type="button"
					disabled={pttDisabled}
					onpointerdown={onPressDown}
					onpointerup={onPressUp}
					onpointerleave={onPressUp}
					onpointercancel={onPressUp}
					oncontextmenu={(e) => e.preventDefault()}
					class="flex h-20 w-20 select-none items-center justify-center rounded-full shadow-lg transition-all duration-150 disabled:opacity-40
						{voice.holding
						? 'scale-110 bg-orange-500 ring-4 ring-orange-400/40'
						: 'bg-zinc-100 hover:bg-white active:scale-105'}"
					style="touch-action: none;"
					aria-label="Push to talk"
				>
					{#if isConnecting}
						<Loader2 size={30} class="animate-spin text-zinc-700" />
					{:else}
						<Mic size={30} class={voice.holding ? 'text-white' : 'text-zinc-900'} />
					{/if}
				</button>
			</div>
		{/if}
	</div>
{/if}
