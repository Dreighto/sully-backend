// Voice SURFACE state machine (LOS-176 / T1b). The single source of truth for
// WHICH voice surface owns the screen, and — within full voice — which named UI
// state the immersive overlay is in.
//
// Before T1b the three surfaces (plain composer, in-composer Talkback, and the
// full-screen realtime Voice Mode) were coordinated by stacked booleans read
// ad-hoc across the page and components (`rtVoice.open` + `voice.active` +
// `composerMode === 'talkback'`), with NO enforced exclusion — nothing stopped
// the full-voice overlay opening on top of a live Talkback loop, running two mic
// graphs at once. This module replaces that flag soup with one named surface
// enum and explicit transitions.
//
// SCOPE — surface coordination ONLY. This machine never touches either
// controller's TRANSPORT (mic / STT / TTS / WebSocket / on-demand GPU services).
// T1a's Talkback bridge (`TALKBACK_STT_VIA_BRIDGE`, $lib/chat/voice.svelte.ts)
// and the realtime controller ($lib/chat/realtime-voice.svelte.ts) keep owning
// their own device resources and gating. T1b adds the mutual-exclusion +
// composer-mount layer on top, reaching the controllers only through the
// explicit `VoiceModeDeps` port.
//
// REACTIVE OWNERSHIP. The machine owns NO reactive state of its own. Every
// read-only getter computes synchronously from the controllers' reactive
// getters (`rtVoice.open`, `rtVoice.phase`, `voice.active`), so reading
// `voiceMode.surface` / `.composerMounted` inside a template or `$derived`
// transitively tracks the underlying `$state` — reactivity stays owned by the
// controllers, exactly where the page binds it. That also makes the machine a
// plain, deterministic module: the decision logic below is exported as pure
// functions and unit-tested without a runes/browser context.

import type { VoicePhase } from '$lib/types/chat-ui';

// The three mutually-exclusive voice surfaces. A single enum makes
// "Talkback ⊻ full-voice" structural — the surface literally cannot be two
// things at once, so the exclusion can't drift out of sync the way parallel
// booleans did.
export type VoiceSurface = 'composer' | 'talkback' | 'full-voice';

// Named full-voice UI states — the four the immersive overlay actually
// distinguishes. Derived from the realtime controller's finer pipeline phase:
// `connecting` folds into THINKING (Sully is working on it), and `error` is
// surfaced by the overlay via the controller's `errorMsg`, not as a UI state.
export type VoiceUiState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';

export interface VoiceModeDeps {
	/** Full-voice pipeline phase (realtime controller `phase`). */
	getVoicePhase: () => VoicePhase;
	/** Is the full-voice overlay open (realtime controller `open`)? */
	isFullVoiceOpen: () => boolean;
	/** Is the Talkback loop active (Talkback controller `active`)? */
	isTalkbackActive: () => boolean;
	/** Open the full-voice overlay (realtime controller `enter()`). */
	openFullVoice: () => Promise<void>;
	/** Close the full-voice overlay (realtime controller `exit()`). */
	closeFullVoice: () => Promise<void>;
	/** Toggle the Talkback loop (Talkback controller `toggleTalkback()`). */
	toggleTalkback: () => Promise<void>;
	/** Stop the Talkback loop (Talkback controller `stopTalkback()`). */
	stopTalkback: (reason?: string) => Promise<void>;
}

export interface VoiceModeMachine {
	/** Which surface currently owns the screen. */
	readonly surface: VoiceSurface;
	/** Named full-voice UI state (meaningful while `surface === 'full-voice'`). */
	readonly uiState: VoiceUiState;
	/** Composer is MOUNTED — false (unmounted, removed from the tree) in full voice. */
	readonly composerMounted: boolean;
	/** Either voice surface owns the screen (the exclusion invariant, surfaced). */
	readonly voiceActive: boolean;
	/** Enter full voice. Stops Talkback first so the two never run at once. */
	enterFullVoice: () => Promise<void>;
	/** Exit full voice back to the composer surface. */
	exitFullVoice: () => Promise<void>;
	/** Toggle Talkback. Refused while full voice owns the screen (mutual exclusion). */
	toggleTalkback: () => Promise<void>;
}

// ── Pure decision logic (exported for unit tests; no runes / no I/O) ─────────

/** Collapse the realtime pipeline phase to the named full-voice UI state. */
export function mapVoicePhase(phase: VoicePhase): VoiceUiState {
	switch (phase) {
		case 'listening':
			return 'LISTENING';
		case 'thinking':
		case 'connecting':
			return 'THINKING';
		case 'speaking':
			return 'SPEAKING';
		case 'idle':
		case 'error':
		default:
			return 'IDLE';
	}
}

/**
 * Resolve the owning surface from the two controllers' live state. Full voice
 * wins if (somehow) both report active — the enter transitions below prevent
 * that, this is just the safe, deterministic collapse of the invariant.
 */
export function resolveSurface(s: {
	fullVoiceOpen: boolean;
	talkbackActive: boolean;
}): VoiceSurface {
	if (s.fullVoiceOpen) return 'full-voice';
	if (s.talkbackActive) return 'talkback';
	return 'composer';
}

/** The composer is mounted on every surface EXCEPT full voice. */
export function composerMountedFor(surface: VoiceSurface): boolean {
	return surface !== 'full-voice';
}

// ── Machine factory ─────────────────────────────────────────────────────────

export function createVoiceModeMachine(deps: VoiceModeDeps): VoiceModeMachine {
	function surface(): VoiceSurface {
		return resolveSurface({
			fullVoiceOpen: deps.isFullVoiceOpen(),
			talkbackActive: deps.isTalkbackActive()
		});
	}

	// Transition: → full-voice. Mutual exclusion (Talkback ⊻ full-voice): stop
	// Talkback BEFORE the overlay takes the screen, so the realtime mic graph
	// never comes up alongside Talkback's.
	async function enterFullVoice(): Promise<void> {
		if (deps.isFullVoiceOpen()) return;
		if (deps.isTalkbackActive()) await deps.stopTalkback();
		await deps.openFullVoice();
	}

	// Transition: full-voice → composer.
	async function exitFullVoice(): Promise<void> {
		await deps.closeFullVoice();
	}

	// Transition: composer ⇄ talkback. Mutual exclusion: never arm Talkback while
	// the full-voice overlay owns the screen (its own controls own the mic).
	// Toggling OFF an active loop is always allowed.
	async function toggleTalkback(): Promise<void> {
		if (deps.isFullVoiceOpen() && !deps.isTalkbackActive()) return;
		await deps.toggleTalkback();
	}

	return {
		get surface() {
			return surface();
		},
		get uiState() {
			return mapVoicePhase(deps.getVoicePhase());
		},
		get composerMounted() {
			return composerMountedFor(surface());
		},
		get voiceActive() {
			return surface() !== 'composer';
		},
		enterFullVoice,
		exitFullVoice,
		toggleTalkback
	};
}
