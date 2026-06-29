// voice_vad_config.ts — Rank 1.5 backend-side VAD config exposure.
//
// PURPOSE: client UI contract. The bridge (Jetson STT, separate process) is
// the authoritative endpointer. This module exposes the SAME values + safe
// clamp ranges + abstract sensitivity presets through `/api/chat/voice-config`
// so the iOS client can render a status panel + settings UI without ever
// becoming the source of truth for VAD.
//
// SOURCE-OF-TRUTH RECONCILIATION (2026-06-27): the defaults below are picked
// to MATCH the live bridge source defaults in
// `/home/dreighto/dev/companion-speech/jetson_stt_bridge.py:155-158`. Running
// boot line (last bridge restart 2026-06-23):
//   [bridge] listening ws://127.0.0.1:18770 (VAD: silence=1200ms thr=0.6 min_speech=350ms; ...)
// The bridge unit (`/etc/systemd/system/logueos-companion-stt.service`) and
// Companion `.env` are BOTH empty of `STT_VAD_*` overrides at exposure time —
// so the Python source defaults are what's live.
//
// The older design spec doc (`docs/superpowers/specs/2026-05-30-sully-voice-mode-design.md`)
// shows starting-point numbers (silence=800, threshold=0.6, min_speech=350)
// that the bridge has since been retuned away from. Treat that doc as
// historical; the bridge source is canon.
//
// Operator can override per-deployment by exporting `STT_VAD_*` to the
// Companion env file — values are clamped + re-read at request time so a
// service restart of `sully-backend` picks them up. The BRIDGE process still
// needs its OWN restart on ROOM to actually adopt a new VAD value.

export type VadSensitivity = 'low' | 'medium' | 'high';

export type VadCurrent = {
	threshold: number;
	silenceDurationMs: number;
	speechPadMs: number;
	minSpeechMs: number;
	startSensitivity: VadSensitivity;
	endSensitivity: VadSensitivity;
};

export type VadClamp = {
	threshold: { min: number; max: number };
	silenceDurationMs: { min: number; max: number };
	speechPadMs: { min: number; max: number };
	minSpeechMs: { min: number; max: number };
	startSensitivity: { values: VadSensitivity[] };
	endSensitivity: { values: VadSensitivity[] };
};

export type VadPreset = {
	id: 'quiet' | 'normal' | 'noisy';
	label: string;
	values: Omit<VadCurrent, 'startSensitivity' | 'endSensitivity'>;
};

export type VadConfig = {
	preset: VadPreset['id'];
	presets: Array<{ id: VadPreset['id']; label: string }>;
	current: VadCurrent;
	clamp: VadClamp;
	authority: 'server';
	purpose: 'client_ui_contract';
	/** Per-field provenance — was this value the bridge source default, or an
	 *  STT_VAD_* env override? Lets the client render "default" vs "tuned"
	 *  badges without round-tripping. Boolean (true=env override) per field. */
	source: {
		threshold: 'bridge_default' | 'env_override';
		silenceDurationMs: 'bridge_default' | 'env_override';
		speechPadMs: 'bridge_default' | 'env_override';
		minSpeechMs: 'bridge_default' | 'env_override';
	};
	/** Receipts: which STT_VAD_* env vars are set on this backend (names only,
	 *  no values — values aren't secrets but we follow least-info). Empty list
	 *  means the canonical bridge defaults are exposed verbatim. */
	envOverridesPresent: string[];
	note: string;
	reconciliation: string;
};

// Defaults MUST match the live bridge source defaults in
// companion-speech/jetson_stt_bridge.py:155-158 (last reconciled 2026-06-27).
// Bumping these without bumping the bridge source — and vice versa — breaks
// the client UI contract. See header comment for the reconciliation receipt.
const DEFAULTS = {
	threshold: 0.6,
	silenceDurationMs: 1200,
	speechPadMs: 250,
	minSpeechMs: 350
} as const;

const CLAMP: VadClamp = {
	threshold: { min: 0.1, max: 0.95 },
	silenceDurationMs: { min: 200, max: 3000 },
	speechPadMs: { min: 0, max: 500 },
	minSpeechMs: { min: 100, max: 2000 },
	startSensitivity: { values: ['low', 'medium', 'high'] },
	endSensitivity: { values: ['low', 'medium', 'high'] }
};

// Preset definitions. The client picks one of these when the operator changes
// environments; server applies the matching env values. Picked deliberately
// AROUND the bridge canon (DEFAULTS), not by absolute numbers, so retuning the
// bridge slides the whole preset table cleanly.
//  - quiet:  trigger easily, end faster — wireless headphones in a quiet room
//  - normal: the bridge default — what the bridge runs out of the box
//  - noisy:  harder to trigger, longer end-of-speech wait — kitchen / car
const PRESETS: VadPreset[] = [
	{
		id: 'quiet',
		label: 'Quiet room',
		values: { threshold: 0.45, silenceDurationMs: 900, speechPadMs: 200, minSpeechMs: 250 }
	},
	{
		id: 'normal',
		label: 'Normal',
		values: { ...DEFAULTS }
	},
	{
		id: 'noisy',
		label: 'Noisy / public',
		values: { threshold: 0.75, silenceDurationMs: 1600, speechPadMs: 300, minSpeechMs: 500 }
	}
];

function clampNumber(value: number, lo: number, hi: number): number {
	if (Number.isNaN(value)) return lo;
	return Math.min(hi, Math.max(lo, value));
}

function parseFloatEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const v = parseFloat(raw);
	return Number.isFinite(v) ? v : fallback;
}

function parseIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const v = parseInt(raw, 10);
	return Number.isFinite(v) ? v : fallback;
}

/** Derive a sensitivity label from a threshold (lower threshold = more
 *  sensitive). Identical mapping for start and end since the bridge uses one
 *  threshold for both edges; the abstract labels exist so the client UI can
 *  show "medium" instead of "0.6" without losing the precise value. */
function thresholdToSensitivity(threshold: number): VadSensitivity {
	if (threshold < 0.5) return 'high';
	if (threshold < 0.7) return 'medium';
	return 'low';
}

/** Identify which preset (if any) matches the current values. Returns
 *  'normal' as the fallback so the client always has a meaningful selection
 *  to show. */
function matchPreset(
	current: Omit<VadCurrent, 'startSensitivity' | 'endSensitivity'>
): VadPreset['id'] {
	for (const p of PRESETS) {
		if (
			Math.abs(p.values.threshold - current.threshold) < 0.001 &&
			p.values.silenceDurationMs === current.silenceDurationMs &&
			p.values.speechPadMs === current.speechPadMs &&
			p.values.minSpeechMs === current.minSpeechMs
		) {
			return p.id;
		}
	}
	return 'normal';
}

export function buildVadConfig(): VadConfig {
	// Read live values from env, clamp to safe bounds, derive sensitivity labels.
	const envThreshold = process.env.STT_VAD_THRESHOLD;
	const envSilence = process.env.STT_VAD_SILENCE_MS;
	const envSpeechPad = process.env.STT_VAD_SPEECH_PAD_MS;
	const envMinSpeech = process.env.STT_VAD_MIN_SPEECH_MS;

	const rawThreshold = parseFloatEnv('STT_VAD_THRESHOLD', DEFAULTS.threshold);
	const rawSilence = parseIntEnv('STT_VAD_SILENCE_MS', DEFAULTS.silenceDurationMs);
	const rawSpeechPad = parseIntEnv('STT_VAD_SPEECH_PAD_MS', DEFAULTS.speechPadMs);
	const rawMinSpeech = parseIntEnv('STT_VAD_MIN_SPEECH_MS', DEFAULTS.minSpeechMs);

	const threshold = clampNumber(rawThreshold, CLAMP.threshold.min, CLAMP.threshold.max);
	const silenceDurationMs = clampNumber(
		rawSilence,
		CLAMP.silenceDurationMs.min,
		CLAMP.silenceDurationMs.max
	);
	const speechPadMs = clampNumber(rawSpeechPad, CLAMP.speechPadMs.min, CLAMP.speechPadMs.max);
	const minSpeechMs = clampNumber(rawMinSpeech, CLAMP.minSpeechMs.min, CLAMP.minSpeechMs.max);

	const sens = thresholdToSensitivity(threshold);
	const current: VadCurrent = {
		threshold,
		silenceDurationMs,
		speechPadMs,
		minSpeechMs,
		startSensitivity: sens,
		endSensitivity: sens
	};

	// Per-field provenance: env_override only if the env var was actually set
	// AND parsed to a finite number. A junk env value (NaN) silently falls back
	// to the bridge default, and we should report bridge_default in that case.
	const envOverridesPresent: string[] = [];
	const tagged = (name: string, raw: string | undefined, used: number, fallback: number) => {
		if (raw && Number.isFinite(parseFloat(raw)) && used !== fallback) {
			envOverridesPresent.push(name);
			return 'env_override' as const;
		}
		return 'bridge_default' as const;
	};

	return {
		preset: matchPreset({ threshold, silenceDurationMs, speechPadMs, minSpeechMs }),
		presets: PRESETS.map((p) => ({ id: p.id, label: p.label })),
		current,
		clamp: CLAMP,
		authority: 'server',
		purpose: 'client_ui_contract',
		source: {
			threshold: tagged('STT_VAD_THRESHOLD', envThreshold, threshold, DEFAULTS.threshold),
			silenceDurationMs: tagged(
				'STT_VAD_SILENCE_MS',
				envSilence,
				silenceDurationMs,
				DEFAULTS.silenceDurationMs
			),
			speechPadMs: tagged('STT_VAD_SPEECH_PAD_MS', envSpeechPad, speechPadMs, DEFAULTS.speechPadMs),
			minSpeechMs: tagged('STT_VAD_MIN_SPEECH_MS', envMinSpeech, minSpeechMs, DEFAULTS.minSpeechMs)
		},
		envOverridesPresent,
		note: 'Server (Jetson STT bridge) is authoritative for endpointing. This block is a CLIENT UI CONTRACT only — clients render values + bounds; the bridge enforces. No setter route yet.',
		reconciliation:
			'Defaults match companion-speech/jetson_stt_bridge.py source (threshold=0.6, silenceDurationMs=1200, speechPadMs=250, minSpeechMs=350). Reconciled 2026-06-27 against bridge boot line.'
	};
}

// Re-exported so tests/harness can assert that what voice-config returns matches
// the canonical presets without importing voice-config (avoids SvelteKit deps).
export const VAD_PRESETS = PRESETS;
export const VAD_DEFAULTS = DEFAULTS;
export const VAD_CLAMP_DEFS = CLAMP;
