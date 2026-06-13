// Voice lifecycle control: brings the on-demand GPU speech services (STT WS +
// TTS HTTP) up when the operator enters voice mode and down when they leave, so
// the GPU is free for other models/tasks while voice is idle.
//
// Uses `sudo -n systemctl ...` against a narrow /etc/sudoers.d/companion-voice
// allowlist (only start/stop/is-active of these two units, passwordless). On
// 'start' we wait until both services are actually READY (STT WS bound + TTS
// /health 200) so the client knows when it can connect, not just that systemd
// accepted the command.

import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { resolveTtsUrl } from './voice_runtime';

const run = promisify(execFile);
const STT_UNIT = 'logueos-companion-stt.service';
const TTS_UNIT = 'logueos-companion-tts.service';
const STT_PORT = Number(process.env.COMPANION_STT_PORT || 18770);
// Guarded: Jetson bridge only, never the local 5060 Chatterbox (see voice_runtime).
const TTS_URL = resolveTtsUrl();

// When TTS_URL points to a remote host (e.g. Kokoro on Jetson), skip all
// systemctl TTS lifecycle ops — the remote service runs persistently and is
// managed by the remote host, not by this machine's systemd. We still probe the
// health endpoint so a downed Jetson surfaces as a readiness failure.
const ttsUrlHost = (() => {
	try {
		return new URL(TTS_URL).hostname;
	} catch {
		return '127.0.0.1';
	}
})();
const TTS_REMOTE = ttsUrlHost !== '127.0.0.1' && ttsUrlHost !== 'localhost';
const START_TIMEOUT_MS = 40000;
const PROBE_TIMEOUT_MS = 1500;
const POLL_INTERVAL_MS = 1000;

type VoiceUnitStatus = 'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | string;

export type VoiceServiceStatus = {
	stt: VoiceUnitStatus;
	tts: VoiceUnitStatus;
	bothReady: boolean;
};

export type VoiceServiceStartResult = {
	ready: boolean;
	errors: string[];
	// Set only on the fast-fail path: a started unit reported `failed` (dead /
	// crash-looping) during the readiness poll, so we returned in <=3s instead of
	// burning the full `START_TIMEOUT_MS` cap. Absent on the ready, timeout, and
	// start-command-error paths (callers that don't care can ignore it).
	reason?: 'unit_failed';
};

export type VoiceServiceStopResult = {
	stopped: true;
};

async function systemctl(action: 'start' | 'stop' | 'is-active', unit: string): Promise<string> {
	try {
		const { stdout } = await run('sudo', ['-n', '/usr/bin/systemctl', action, unit], {
			timeout: 15000
		});
		return (stdout || '').trim() || 'ok';
	} catch (e: unknown) {
		// is-active exits non-zero when inactive — that's a normal answer, not an error.
		const out = (e as { stdout?: string })?.stdout?.trim();
		if (action === 'is-active') return out || 'inactive';
		throw e;
	}
}

function portOpen(
	port: number,
	host = '127.0.0.1',
	timeoutMs = PROBE_TIMEOUT_MS
): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = new net.Socket();
		const done = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(timeoutMs);
		sock.once('connect', () => done(true));
		sock.once('timeout', () => done(false));
		sock.once('error', () => done(false));
		sock.connect(port, host);
	});
}

async function ttsHealthy(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
	try {
		const r = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		return r.ok;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

export async function getVoiceServiceStatus(): Promise<VoiceServiceStatus> {
	const [stt, ttsSystemd, healthy] = await Promise.all([
		systemctl('is-active', STT_UNIT),
		TTS_REMOTE ? Promise.resolve('') : systemctl('is-active', TTS_UNIT),
		ttsHealthy()
	]);
	// Remote TTS: derive status from health probe since there's no local unit.
	const tts: VoiceUnitStatus = TTS_REMOTE ? (healthy ? 'active' : 'inactive') : ttsSystemd;
	const bothReady = stt === 'active' && tts === 'active' && healthy;
	return { stt, tts, bothReady };
}

// Fast-fail probe: name the first unit we started that systemd reports as
// `failed`. A healthy cold start sits in `activating` the whole time it loads
// its model, so `failed` is an unambiguous "this is never coming up" signal —
// the caller returns immediately instead of waiting out the 40s cap. A crash
// loop (Restart=on-failure) flaps activating↔failed; the per-iteration poll
// samples the `failed` phase within a cycle, so the worst case to a verdict is
// ~3s. Only probes units we actually started locally: remote TTS (Jetson) has
// no local systemd unit and is covered by the health probe instead.
async function firstFailedLocalUnit(skipTtsStart: boolean): Promise<string | null> {
	const units = [STT_UNIT];
	if (!skipTtsStart) units.push(TTS_UNIT);
	for (const unit of units) {
		if ((await systemctl('is-active', unit)) === 'failed') return unit;
	}
	return null;
}

export async function startVoiceServices(
	maxWaitMs = START_TIMEOUT_MS,
	opts?: { skipTts?: boolean }
): Promise<VoiceServiceStartResult> {
	const skipTts = opts?.skipTts ?? false;
	// Remote TTS (Jetson) is always-on — never start it via systemctl.
	// We still probe its health so a downed Jetson shows as a readiness failure.
	const skipTtsStart = skipTts || TTS_REMOTE;
	const errors: string[] = [];
	try {
		const starts: Promise<string>[] = [systemctl('start', STT_UNIT)];
		if (!skipTtsStart) starts.push(systemctl('start', TTS_UNIT));
		await Promise.all(starts);
	} catch (e) {
		errors.push(`failed to start speech services: ${errorMessage(e)}`);
		return { ready: false, errors };
	}

	// Wait for models to load + ports to bind (cold start ~10-20s on the GPU).
	// When skipTts is true (ElevenLabs is primary) we skip the TTS health probe —
	// Chatterbox wasn't started and shouldn't block the voice session.
	// Remote TTS is probed (skipTts=false path) so Jetson reachability is confirmed.
	const deadline = Date.now() + maxWaitMs;
	while (Date.now() < deadline) {
		const remaining = Math.max(1, deadline - Date.now());
		const probeTimeout = Math.min(PROBE_TIMEOUT_MS, remaining);
		const sttOk = await portOpen(STT_PORT, '127.0.0.1', probeTimeout);
		const ttsOk = skipTts || (await ttsHealthy(probeTimeout));
		if (sttOk && ttsOk) {
			return { ready: true, errors };
		}
		// Not ready yet — is this a slow-but-healthy cold start, or a dead /
		// crash-looping unit eating the deadline? Probe `is-active` and bail in
		// <=3s on a `failed` unit instead of waiting out the full cap.
		const failedUnit = await firstFailedLocalUnit(skipTtsStart);
		if (failedUnit) {
			errors.push(`${failedUnit} failed to start (crash or start failure)`);
			return { ready: false, reason: 'unit_failed', errors };
		}
		await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
	}

	errors.push('speech services did not become ready in time');
	return { ready: false, errors };
}

export async function stopVoiceServices(): Promise<VoiceServiceStopResult> {
	const stops: Promise<string>[] = [systemctl('stop', STT_UNIT)];
	if (!TTS_REMOTE) stops.push(systemctl('stop', TTS_UNIT));
	await Promise.all(stops);
	return { stopped: true };
}

/**
 * Recycle ONLY the TTS service (stop+start) and wait until it's healthy again.
 *
 * A CUDA device-side assert poisons the TTS process's GPU context
 * irrecoverably — every subsequent /tts returns 500 instantly. The Python
 * service catches the error and keeps running, so systemd's Restart=on-failure
 * never fires and a plain `start` is a no-op. Talkback calls this on a synth
 * failure to get a fresh process (it also recovers a cold/torn-down service).
 * STT is left untouched (talkback doesn't need it). Uses the same narrow
 * sudoers allowlist (stop + start are permitted; restart is not).
 */
export async function restartTtsService(maxWaitMs = START_TIMEOUT_MS): Promise<boolean> {
	if (TTS_REMOTE) {
		// Can't restart a remote service via systemctl — just probe its health.
		// If Kokoro on the Jetson is healthy, we're good; it manages its own process.
		return ttsHealthy(maxWaitMs);
	}
	try {
		await systemctl('stop', TTS_UNIT);
	} catch {
		/* stopping an already-stopped unit is fine */
	}
	try {
		await systemctl('start', TTS_UNIT);
	} catch {
		return false;
	}
	const deadline = Date.now() + maxWaitMs;
	while (Date.now() < deadline) {
		const probe = Math.min(PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
		if (await ttsHealthy(probe)) return true;
		await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
	}
	return false;
}
