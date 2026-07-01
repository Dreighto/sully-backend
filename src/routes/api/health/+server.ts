import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { appIdentity, runMode } from '$lib/server/config';

export const GET: RequestHandler = async () => {
	return json({
		ok: true,
		app: appIdentity.appName,
		base_path: appIdentity.basePath,
		route: `${appIdentity.basePath}/api/health`,
		mode: runMode.mode,
		version: __BUILD_VERSION__,
		uptime_seconds: Math.round(process.uptime() * 10) / 10
	});
};
