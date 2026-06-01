<script lang="ts">
	// Immersive full-screen Voice Mode overlay. Renders the realtime voice
	// controller's state: a phase-reactive orb, the operator's live transcript,
	// the companion's streaming reply (toggleable), and the turn controls.
	// Two modes:
	//   • continuous (hands-free) — mic always live, server VAD endpoints the turn;
	//     the big button is MUTE, tap the orb to interrupt a reply.
	//   • ptt — press-and-hold the big button to talk.
	// All audio/STT/TTS logic lives in the controller
	// ($lib/chat/realtime-voice.svelte.ts); this component is presentation +
	// gesture wiring.

	import {
		Mic,
		MicOff,
		X,
		Captions,
		CaptionsOff,
		Loader2,
		AudioLines,
		AlertCircle,
		Hand,
		Info,
		Drama,
		ChevronDown,
		Check,
		Infinity as InfinityIcon
	} from 'lucide-svelte';
	import SullyAvatar from './SullyAvatar.svelte';
	import type { RealtimeVoiceController } from '$lib/chat/realtime-voice.svelte';

	let { voice }: { voice: RealtimeVoiceController } = $props();

	// ── Diagnostic: mic permission + PWA install state ──────────────────
	// iOS PWA mic-permission behavior is famously inconsistent. This probes
	// the actual state on entry so Captain can see what iOS REALLY thinks at
	// any given moment (vs. inferring from the prompt's UI). Settles the
	// "did the permission persist?" question with data instead of theory.
	type MicProbe = {
		permission: 'granted' | 'prompt' | 'denied' | 'unsupported' | 'pending';
		standalone: boolean;
		displayMode: string;
		secureContext: boolean;
		hostname: string;
		userAgent: string;
	};
	let probe = $state<MicProbe>({
		permission: 'pending',
		standalone: false,
		displayMode: '',
		secureContext: false,
		hostname: '',
		userAgent: ''
	});
	let showProbe = $state(false);
	let showVoicePicker = $state(false);

	async function runProbe(): Promise<void> {
		const result: MicProbe = {
			permission: 'unsupported',
			standalone: false,
			displayMode: 'unknown',
			secureContext: false,
			hostname: '',
			userAgent: ''
		};
		if (typeof window === 'undefined') {
			probe = result;
			return;
		}
		result.hostname = location.hostname;
		result.userAgent = navigator.userAgent.slice(0, 80);
		result.secureContext = window.isSecureContext;
		// iOS Safari: navigator.standalone === true when launched from home-screen icon.
		const std = (navigator as Navigator & { standalone?: boolean }).standalone;
		result.standalone = std === true;
		const modes = ['standalone', 'fullscreen', 'minimal-ui', 'browser'];
		for (const m of modes) {
			if (window.matchMedia?.(`(display-mode: ${m})`).matches) {
				result.displayMode = m;
				break;
			}
		}
		try {
			if (navigator.permissions?.query) {
				const status = await navigator.permissions.query({
					name: 'microphone' as PermissionName
				});
				result.permission = status.state as MicProbe['permission'];
			}
		} catch {
			result.permission = 'unsupported';
		}
		probe = result;
	}

	// Re-probe every time voice mode opens AND on visibility-change (so when
	// Captain backgrounds + foregrounds, we see whether iOS re-evaluated state).
	$effect(() => {
		if (voice.open) void runProbe();
	});

	// iOS suspends AudioContexts when the tab/PWA backgrounds; resume on return.
	$effect(() => {
		const onVisible = () => {
			if (document.visibilityState === 'visible') {
				voice.resumeAudio();
				void runProbe();
			}
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

	// Push-to-talk gesture (PTT mode). Pointer events cover mouse + touch; we
	// suppress the default so a long touch-press doesn't select text / fire the
	// context menu.
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
	const isContinuous = $derived(voice.mode === 'continuous');
	const interruptible = $derived(voice.phase === 'thinking' || voice.phase === 'speaking');
	const activeVoiceLabel = $derived(
		voice.voices.find((v) => v.id === voice.voiceId)?.label ?? voice.voiceId
	);

	// Mode-aware status line under the controls.
	const statusLabel = $derived.by(() => {
		if (voice.phase === 'error') return 'Something went wrong';
		if (voice.phase === 'connecting') return 'Waking the voice…';
		if (isContinuous && voice.muted) return 'Muted — tap the mic to talk';
		if (voice.phase === 'listening') return 'Listening…';
		if (voice.phase === 'thinking') return 'Thinking…';
		if (voice.phase === 'speaking')
			return isContinuous ? 'Speaking — tap to interrupt' : 'Speaking — hold to interrupt';
		// idle
		return isContinuous ? 'Paused' : 'Hold to talk';
	});

	// Map the live voice phase to Sully's avatar state — she IS the orb now.
	const voiceAvatarState = $derived(
		voice.phase === 'speaking'
			? 'speaking'
			: voice.phase === 'thinking' || isConnecting
				? 'thinking'
				: voice.phase === 'listening' && !voice.muted
					? 'listening'
					: 'idle'
	);
</script>

{#if voice.open}
	<div
		class="fixed inset-0 z-[100] flex flex-col bg-zinc-950/95 text-zinc-100 backdrop-blur-xl"
		role="dialog"
		aria-modal="true"
		aria-label="Voice mode"
	>
		<!-- Header -->
		<div
			class="flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2"
		>
			<div class="flex items-center gap-2 text-sm font-medium text-zinc-400">
				<AudioLines size={16} class="text-orange-400" />
				<span>Voice</span>
			</div>
			<div class="flex items-center gap-1">
				<!-- Voice picker: switch which voice Sully speaks in (Emma cloud / Sulley local) -->
				{#if voice.voices.length > 1}
					<div class="relative">
						<button
							type="button"
							onclick={() => (showVoicePicker = !showVoicePicker)}
							disabled={isConnecting || isError}
							class="flex h-10 items-center gap-1.5 rounded-full px-3 text-sm text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
							aria-label="Change voice"
							aria-expanded={showVoicePicker}
							title="Change voice"
						>
							<Drama size={16} class="text-orange-400" />
							<span class="max-w-[7rem] truncate">{activeVoiceLabel}</span>
							<ChevronDown size={14} class={showVoicePicker ? 'rotate-180' : ''} />
						</button>
						{#if showVoicePicker}
							<div
								class="absolute top-12 right-0 z-10 w-64 rounded-xl border border-zinc-800 bg-zinc-900/95 p-1 shadow-xl backdrop-blur"
								role="menu"
							>
								{#each voice.voices as v (v.id)}
									<button
										type="button"
										role="menuitemradio"
										aria-checked={v.id === voice.voiceId}
										onclick={() => {
											void voice.setVoice(v.id);
											showVoicePicker = false;
										}}
										class="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition hover:bg-zinc-800"
									>
										<Check
											size={16}
											class={v.id === voice.voiceId
												? 'mt-0.5 shrink-0 text-emerald-400'
												: 'mt-0.5 shrink-0 text-transparent'}
										/>
										<span class="flex flex-col">
											<span class="text-sm text-zinc-100">{v.label}</span>
											<span class="text-[11px] text-zinc-500">{v.blurb}</span>
										</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
				<!-- Diagnostic probe (small ⓘ — toggles a permission + PWA state panel) -->
				<button
					type="button"
					onclick={() => (showProbe = !showProbe)}
					class="flex h-10 w-10 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100"
					aria-label="Toggle mic permission + PWA diagnostic"
					title="Mic permission + PWA diagnostic"
				>
					<Info size={18} />
				</button>
				<!-- Mode toggle: hands-free ⇄ push-to-talk -->
				<button
					type="button"
					onclick={() => voice.toggleMode()}
					disabled={isConnecting || isError}
					class="flex h-10 w-10 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
					aria-label={isContinuous ? 'Switch to push-to-talk' : 'Switch to hands-free'}
					title={isContinuous
						? 'Hands-free (tap for push-to-talk)'
						: 'Push-to-talk (tap for hands-free)'}
				>
					{#if isContinuous}
						<InfinityIcon size={20} />
					{:else}
						<Hand size={18} />
					{/if}
				</button>
				<!-- Captions toggle -->
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
				<!-- Close -->
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

		{#if showProbe}
			<!-- Diagnostic panel — shows what iOS *actually* reports about mic permission +
			     PWA install state. Useful for confirming whether re-prompting is iOS
			     dropping the grant vs. our code asking when it shouldn't. -->
			<div
				class="mx-4 mb-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 font-mono text-[11px] text-zinc-300"
			>
				<div class="mb-1 flex items-center justify-between text-zinc-400">
					<span>diagnostic</span>
					<button
						type="button"
						onclick={() => void runProbe()}
						class="rounded px-2 py-0.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100"
						>refresh</button
					>
				</div>
				<div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
					<span class="text-zinc-500">mic permission:</span>
					<span
						class={probe.permission === 'granted'
							? 'text-emerald-400'
							: probe.permission === 'denied'
								? 'text-red-400'
								: probe.permission === 'prompt'
									? 'text-amber-400'
									: 'text-zinc-500'}>{probe.permission}</span
					>
					<span class="text-zinc-500">standalone PWA:</span>
					<span class={probe.standalone ? 'text-emerald-400' : 'text-amber-400'}>
						{probe.standalone ? 'yes' : 'no (in Safari?)'}
					</span>
					<span class="text-zinc-500">display mode:</span>
					<span>{probe.displayMode}</span>
					<span class="text-zinc-500">secure context:</span>
					<span class={probe.secureContext ? 'text-emerald-400' : 'text-red-400'}>
						{probe.secureContext ? 'yes' : 'NO'}
					</span>
					<span class="text-zinc-500">hostname:</span>
					<span class="break-all">{probe.hostname}</span>
				</div>
				<div class="mt-2 border-t border-zinc-800 pt-2 leading-snug text-zinc-400">
					<p class="mb-1 text-zinc-300">iOS note:</p>
					<p>
						If this keeps showing a one-time mic prompt in the Home Screen app, set the Safari
						website permission manually: open this same domain in Safari, tap the page menu, open
						Website Settings, then set Microphone to Allow. If iOS still prompts after a cold PWA
						restart, that is a WebKit/iOS standalone-app limitation, not a Companion setting.
					</p>
				</div>
			</div>
		{/if}

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
				<!-- Phase orb (tap to interrupt while the companion is thinking/speaking) -->
				<button
					type="button"
					onclick={() => voice.interrupt()}
					disabled={!interruptible}
					class="relative flex h-32 w-32 items-center justify-center rounded-full {interruptible
						? 'cursor-pointer'
						: 'cursor-default'}"
					aria-label={interruptible ? 'Interrupt' : 'Voice status'}
					title={interruptible ? 'Tap to interrupt' : ''}
				>
					<SullyAvatar state={voiceAvatarState} size={128} />
				</button>

				<!-- Operator's live / final utterance -->
				<div class="min-h-[2rem] max-w-2xl text-center text-lg font-medium text-zinc-100">
					{voice.partial || voice.userText}
				</div>

				<!-- Companion reply (captions) -->
				{#if voice.captions && voice.replyText}
					<div
						class="max-h-[40vh] max-w-2xl overflow-y-auto rounded-2xl bg-zinc-900/70 px-5 py-4 text-center text-base leading-relaxed whitespace-pre-wrap text-zinc-300"
					>
						{voice.replyText}
					</div>
				{/if}
			{/if}
		</div>

		<!-- Bottom control -->
		{#if !isError}
			<div
				class="flex flex-col items-center gap-3 px-6 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
			>
				<p class="text-sm text-zinc-400">{statusLabel}</p>
				{#if isContinuous}
					<!-- Hands-free: the big button is MUTE/UNMUTE -->
					<button
						type="button"
						onclick={() => voice.toggleMute()}
						disabled={isConnecting}
						class="flex h-20 w-20 items-center justify-center rounded-full shadow-lg transition-all duration-150 select-none disabled:opacity-40
							{voice.muted
							? 'bg-zinc-800 ring-1 ring-zinc-700'
							: 'bg-orange-500 ring-4 ring-orange-400/30 active:scale-105'}"
						aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
						aria-pressed={voice.muted}
					>
						{#if isConnecting}
							<Loader2 size={30} class="animate-spin text-zinc-300" />
						{:else if voice.muted}
							<MicOff size={30} class="text-zinc-400" />
						{:else}
							<Mic size={30} class="text-white" />
						{/if}
					</button>
				{:else}
					<!-- Push-to-talk: press and hold -->
					<button
						type="button"
						disabled={isConnecting}
						onpointerdown={onPressDown}
						onpointerup={onPressUp}
						onpointerleave={onPressUp}
						onpointercancel={onPressUp}
						oncontextmenu={(e) => e.preventDefault()}
						class="flex h-20 w-20 items-center justify-center rounded-full shadow-lg transition-all duration-150 select-none disabled:opacity-40
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
				{/if}
			</div>
		{/if}
	</div>
{/if}
