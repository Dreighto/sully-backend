import { describe, it, expect, vi } from 'vitest';
import {
	createVoiceModeMachine,
	mapVoicePhase,
	resolveSurface,
	composerMountedFor,
	type VoiceModeDeps
} from '../src/lib/chat/voice-mode.svelte';
import type { VoicePhase } from '../src/lib/types/chat-ui';

// LOS-176 (T1b) — Voice UI separation. These exercise the SURFACE state
// machine's pure decision logic + its mutual-exclusion transitions with mock
// controller deps. The browser-coupled overlay + controllers are verified in
// the Playwright WebKit suite + on-device (per the ticket's Done-when).

describe('mapVoicePhase — pipeline phase → named full-voice UI state', () => {
	it('maps each phase to the canonical IDLE/LISTENING/THINKING/SPEAKING state', () => {
		expect(mapVoicePhase('idle')).toBe('IDLE');
		expect(mapVoicePhase('listening')).toBe('LISTENING');
		expect(mapVoicePhase('thinking')).toBe('THINKING');
		// connecting folds into THINKING — Sully is "working on it".
		expect(mapVoicePhase('connecting')).toBe('THINKING');
		expect(mapVoicePhase('speaking')).toBe('SPEAKING');
		// error is surfaced separately by the overlay (errorMsg), not a UI state.
		expect(mapVoicePhase('error')).toBe('IDLE');
	});
});

describe('resolveSurface — single source of truth for the owning surface', () => {
	it('is composer when neither voice surface is active', () => {
		expect(resolveSurface({ fullVoiceOpen: false, talkbackActive: false })).toBe('composer');
	});
	it('is talkback when only Talkback is active', () => {
		expect(resolveSurface({ fullVoiceOpen: false, talkbackActive: true })).toBe('talkback');
	});
	it('is full-voice when the overlay is open', () => {
		expect(resolveSurface({ fullVoiceOpen: true, talkbackActive: false })).toBe('full-voice');
	});
	it('full-voice wins if both somehow report active (safe exclusion collapse)', () => {
		expect(resolveSurface({ fullVoiceOpen: true, talkbackActive: true })).toBe('full-voice');
	});
});

describe('composerMountedFor — composer unmounted only in full voice', () => {
	it('mounted on composer + talkback, UNMOUNTED in full voice', () => {
		expect(composerMountedFor('composer')).toBe(true);
		expect(composerMountedFor('talkback')).toBe(true);
		expect(composerMountedFor('full-voice')).toBe(false);
	});
});

type MockState = { phase: VoicePhase; fullVoiceOpen: boolean; talkbackActive: boolean };

function makeMachine(initial: Partial<MockState> = {}) {
	const state: MockState = {
		phase: initial.phase ?? 'idle',
		fullVoiceOpen: initial.fullVoiceOpen ?? false,
		talkbackActive: initial.talkbackActive ?? false
	};
	const order: string[] = [];
	const deps: VoiceModeDeps = {
		getVoicePhase: () => state.phase,
		isFullVoiceOpen: () => state.fullVoiceOpen,
		isTalkbackActive: () => state.talkbackActive,
		openFullVoice: vi.fn(async () => {
			order.push('openFullVoice');
			state.fullVoiceOpen = true;
		}),
		closeFullVoice: vi.fn(async () => {
			order.push('closeFullVoice');
			state.fullVoiceOpen = false;
		}),
		toggleTalkback: vi.fn(async () => {
			order.push('toggleTalkback');
			state.talkbackActive = !state.talkbackActive;
		}),
		stopTalkback: vi.fn(async () => {
			order.push('stopTalkback');
			state.talkbackActive = false;
		})
	};
	return { machine: createVoiceModeMachine(deps), deps, state, order };
}

describe('createVoiceModeMachine — surface getters track the controllers', () => {
	it('reports composer surface + mounted composer by default', () => {
		const { machine } = makeMachine();
		expect(machine.surface).toBe('composer');
		expect(machine.composerMounted).toBe(true);
		expect(machine.voiceActive).toBe(false);
		expect(machine.uiState).toBe('IDLE');
	});

	it('reflects live controller state through the getters (no own state)', () => {
		const { machine, state } = makeMachine();
		state.talkbackActive = true;
		expect(machine.surface).toBe('talkback');
		expect(machine.composerMounted).toBe(true);
		expect(machine.voiceActive).toBe(true);

		state.fullVoiceOpen = true;
		state.phase = 'speaking';
		expect(machine.surface).toBe('full-voice');
		expect(machine.composerMounted).toBe(false); // unmounted in full voice
		expect(machine.uiState).toBe('SPEAKING');
	});
});

describe('mutual exclusion: Talkback ⊻ full-voice (enforced in the machine)', () => {
	it('enterFullVoice stops an active Talkback FIRST, then opens full voice', async () => {
		const { machine, deps, order } = makeMachine({ talkbackActive: true });
		await machine.enterFullVoice();
		expect(deps.stopTalkback).toHaveBeenCalledTimes(1);
		expect(deps.openFullVoice).toHaveBeenCalledTimes(1);
		expect(order).toEqual(['stopTalkback', 'openFullVoice']); // order is the invariant
		expect(machine.surface).toBe('full-voice');
	});

	it('enterFullVoice does not stop Talkback when it is not active', async () => {
		const { machine, deps } = makeMachine();
		await machine.enterFullVoice();
		expect(deps.stopTalkback).not.toHaveBeenCalled();
		expect(deps.openFullVoice).toHaveBeenCalledTimes(1);
	});

	it('enterFullVoice is a no-op when full voice is already open', async () => {
		const { machine, deps } = makeMachine({ fullVoiceOpen: true });
		await machine.enterFullVoice();
		expect(deps.openFullVoice).not.toHaveBeenCalled();
		expect(deps.stopTalkback).not.toHaveBeenCalled();
	});

	it('toggleTalkback refuses to ARM while full voice owns the screen', async () => {
		const { machine, deps } = makeMachine({ fullVoiceOpen: true });
		await machine.toggleTalkback();
		expect(deps.toggleTalkback).not.toHaveBeenCalled();
	});

	it('toggleTalkback arms Talkback when no voice surface owns the screen', async () => {
		const { machine, deps } = makeMachine();
		await machine.toggleTalkback();
		expect(deps.toggleTalkback).toHaveBeenCalledTimes(1);
		expect(machine.surface).toBe('talkback');
	});

	it('exitFullVoice closes the overlay back to the composer surface', async () => {
		const { machine, deps } = makeMachine({ fullVoiceOpen: true });
		await machine.exitFullVoice();
		expect(deps.closeFullVoice).toHaveBeenCalledTimes(1);
		expect(machine.surface).toBe('composer');
		expect(machine.composerMounted).toBe(true);
	});
});
