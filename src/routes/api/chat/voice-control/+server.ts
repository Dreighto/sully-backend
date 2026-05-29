// Voice lifecycle control: brings the on-demand GPU speech services (STT WS +
// TTS HTTP) up when the operator enters voice mode and down when they leave, so
// the GPU is free for other models/tasks while voice is idle.
//
// Uses `sudo -n systemctl ...` against a narrow /etc/sudoers.d/companion-voice
// allowlist (only start/stop/is-active of these two units, passwordless). On
// 'start' we wait until both services are actually READY (STT WS bound + TTS
// /health 200) so the client knows when it can connect, not just that systemd
// accepted the command.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';

const run = promisify(execFile);
const STT_UNIT = 'logueos-companion-stt.service';
const TTS_UNIT = 'logueos-companion-tts.service';
const STT_PORT = Number(process.env.COMPANION_STT_PORT || 18770);
const TTS_URL = (process.env.COMPANION_TTS_URL || 'http://127.0.0.1:18771').replace(/\/+$/, '');

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

function portOpen(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
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

async function ttsHealthy(): Promise<boolean> {
	try {
		const r = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(1500) });
		return r.ok;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const POST: RequestHandler = async ({ request }) => {
	let action: string;
	try {
		action = (await request.json()).action;
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	if (action === 'status') {
		const [stt, tts] = await Promise.all([
			systemctl('is-active', STT_UNIT),
			systemctl('is-active', TTS_UNIT)
		]);
		const ready = stt === 'active' && tts === 'active' && (await ttsHealthy());
		return json({ stt, tts, ready });
	}

	if (action === 'stop') {
		await Promise.all([systemctl('stop', STT_UNIT), systemctl('stop', TTS_UNIT)]);
		return json({ stopped: true });
	}

	if (action === 'start') {
		try {
			await Promise.all([systemctl('start', STT_UNIT), systemctl('start', TTS_UNIT)]);
		} catch {
			return json({ error: 'failed to start speech services' }, { status: 500 });
		}
		// Wait for models to load + ports to bind (cold start ~10-20s on the GPU).
		const deadline = Date.now() + 40000;
		while (Date.now() < deadline) {
			if ((await portOpen(STT_PORT)) && (await ttsHealthy())) {
				return json({ ready: true });
			}
			await sleep(1000);
		}
		return json({ ready: false, error: 'speech services did not become ready in time' }, { status: 504 });
	}

	return json({ error: 'unknown action' }, { status: 400 });
};
