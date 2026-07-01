import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { appIdentity, runMode } from '$lib/server/config';

const pkgJson = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string };
const version: string = pkgJson.version;

export const GET: RequestHandler = async () => {
	return json({
		ok: true,
		app: appIdentity.appName,
		base_path: appIdentity.basePath,
		route: `${appIdentity.basePath}/api/health`,
		mode: runMode.mode,
		version,
		uptime_seconds: Math.round(process.uptime() * 10) / 10
	});
};
