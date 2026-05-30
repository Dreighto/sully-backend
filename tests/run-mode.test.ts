import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadRunMode(mode: string | undefined) {
	vi.resetModules();

	if (mode === undefined) {
		vi.stubEnv('LOGUEOS_APP_MODE', undefined);
	} else {
		vi.stubEnv('LOGUEOS_APP_MODE', mode);
	}

	vi.doMock('$env/dynamic/private', () => ({
		env: mode === undefined ? {} : { LOGUEOS_APP_MODE: mode }
	}));

	const { runMode } = await import('$lib/server/config');
	return runMode;
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.doUnmock('$env/dynamic/private');
});

describe('runMode', () => {
	it('disables kernel-coupled features in companion mode', async () => {
		await expect(loadRunMode('companion')).resolves.toMatchObject({
			mode: 'companion',
			companion: true,
			completionPoller: false,
			dispatchEnabled: false,
			kernelWired: false
		});
	});

	it('enables kernel wiring in wired mode', async () => {
		await expect(loadRunMode('wired')).resolves.toMatchObject({
			mode: 'wired',
			kernelWired: true,
			companion: false
		});
	});

	it('defaults safely when LOGUEOS_APP_MODE is unset', async () => {
		await expect(loadRunMode(undefined)).resolves.toMatchObject({
			mode: 'wired',
			kernelWired: true,
			companion: false
		});
	});

	it.each(['', 'garbage'])('defaults safely for %j LOGUEOS_APP_MODE', async (mode) => {
		await expect(loadRunMode(mode)).resolves.toMatchObject({
			mode,
			kernelWired: true,
			companion: false
		});
	});
});
