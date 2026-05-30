import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { promisify } from 'node:util';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
	execFile: execFileMock
}));

function mockSystemctl(responses: Record<string, string>) {
	execFileMock.mockImplementation((_cmd, args: string[], _options, callback) => {
		const action = args[2];
		const unit = args[3];
		const key = `${action}:${unit}`;
		const stdout = responses[key] ?? 'ok';
		callback(null, { stdout: `${stdout}\n`, stderr: '' });
	});
}

async function listenOnRandomPort(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
	return address.port;
}

async function loadVoiceServices(sttPort: number, ttsUrl = 'http://127.0.0.1:18771') {
	vi.resetModules();
	process.env.COMPANION_STT_PORT = String(sttPort);
	process.env.COMPANION_TTS_URL = ttsUrl;
	return import('../src/lib/server/voice_services');
}

beforeEach(() => {
	execFileMock.mockReset();
	vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.COMPANION_STT_PORT;
	delete process.env.COMPANION_TTS_URL;
});

describe('voice_services', () => {
	it('maps systemd status and readiness', async () => {
		mockSystemctl({
			'is-active:logueos-companion-stt.service': 'active',
			'is-active:logueos-companion-tts.service': 'inactive'
		});
		vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

		const { getVoiceServiceStatus } = await loadVoiceServices(9);
		await expect(getVoiceServiceStatus()).resolves.toEqual({
			stt: 'active',
			tts: 'inactive',
			bothReady: false
		});
		expect(execFileMock).toHaveBeenCalledWith(
			'sudo',
			['-n', '/usr/bin/systemctl', 'is-active', 'logueos-companion-stt.service'],
			{ timeout: 15000 },
			expect.any(Function)
		);
	});

	it('starts both services and reports ready once STT and TTS respond', async () => {
		const sttServer = createServer((socket) => socket.end());
		const sttPort = await listenOnRandomPort(sttServer);
		mockSystemctl({
			'start:logueos-companion-stt.service': 'ok',
			'start:logueos-companion-tts.service': 'ok'
		});
		vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

		try {
			const { startVoiceServices } = await loadVoiceServices(sttPort, 'http://tts.test');
			await expect(startVoiceServices(100)).resolves.toEqual({ ready: true, errors: [] });
			expect(execFileMock).toHaveBeenCalledWith(
				'sudo',
				['-n', '/usr/bin/systemctl', 'start', 'logueos-companion-stt.service'],
				{ timeout: 15000 },
				expect.any(Function)
			);
			expect(fetch).toHaveBeenCalledWith('http://tts.test/health', {
				signal: expect.any(AbortSignal)
			});
		} finally {
			await promisify(sttServer.close.bind(sttServer))();
		}
	});

	it('returns a timeout error when readiness probes never pass', async () => {
		mockSystemctl({
			'start:logueos-companion-stt.service': 'ok',
			'start:logueos-companion-tts.service': 'ok'
		});
		vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));

		const { startVoiceServices } = await loadVoiceServices(9);
		await expect(startVoiceServices(5)).resolves.toEqual({
			ready: false,
			errors: ['speech services did not become ready in time']
		});
	});
});
