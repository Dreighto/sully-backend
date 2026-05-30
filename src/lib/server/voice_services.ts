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

const run = promisify(execFile);
const STT_UNIT = 'logueos-companion-stt.service';
const TTS_UNIT = 'logueos-companion-tts.service';
const STT_PORT = Number(process.env.COMPANION_STT_PORT || 18770);
const TTS_URL = (process.env.COMPANION_TTS_URL || 'http://127.0.0.1:18771').replace(/\/+$/, '');
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

function portOpen(port: number, host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
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
	const [stt, tts] = await Promise.all([
		systemctl('is-active', STT_UNIT),
		systemctl('is-active', TTS_UNIT)
	]);
	const bothReady = stt === 'active' && tts === 'active' && (await ttsHealthy());
	return { stt, tts, bothReady };
}

export async function startVoiceServices(
	maxWaitMs = START_TIMEOUT_MS
): Promise<VoiceServiceStartResult> {
	const errors: string[] = [];
	try {
		await Promise.all([systemctl('start', STT_UNIT), systemctl('start', TTS_UNIT)]);
	} catch (e) {
		errors.push(`failed to start speech services: ${errorMessage(e)}`);
		return { ready: false, errors };
	}

	// Wait for models to load + ports to bind (cold start ~10-20s on the GPU).
	const deadline = Date.now() + maxWaitMs;
	while (Date.now() < deadline) {
		const remaining = Math.max(1, deadline - Date.now());
		const probeTimeout = Math.min(PROBE_TIMEOUT_MS, remaining);
		if ((await portOpen(STT_PORT, '127.0.0.1', probeTimeout)) && (await ttsHealthy(probeTimeout))) {
			return { ready: true, errors };
		}
		await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
	}

	errors.push('speech services did not become ready in time');
	return { ready: false, errors };
}

export async function stopVoiceServices(): Promise<VoiceServiceStopResult> {
	await Promise.all([systemctl('stop', STT_UNIT), systemctl('stop', TTS_UNIT)]);
	return { stopped: true };
}
