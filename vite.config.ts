import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Build-time identifiers surfaced for deploy verification (verify-deploy: confirm
// the running build SHA matches HEAD). Inlined as constants via Vite `define`.
function getBuildVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
		return String(pkg.version || '0.0.0');
	} catch {
		return '0.0.0';
	}
}
function getBuildSha(): string {
	try {
		return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
	} catch {
		return 'unknown';
	}
}
const BUILD_VERSION = getBuildVersion();
const BUILD_SHA = getBuildSha();
const BUILD_TS = new Date().toISOString();

// Port 18769 — next free slot in the LogueOS 18xxx family (18766 gateway, 18767
// Console, 18768 dev page, 19100 listener, 11434 ollama all in use). Bound to
// 0.0.0.0 so the operator's phone can reach it over Tailscale. allowedHosts:true
// is REQUIRED — Vite 8 blocks unrecognized Host headers with a silent 500, which
// kills Tailscale/LAN access (see reference_vite8_allowed_hosts).
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// sharp is a native libvips module; bundling it into the ESM server build
	// breaks its CommonJS loader (__dirname is undefined in ESM). Keep it external
	// so it loads from node_modules at runtime — see gemini.ts image downsample.
	ssr: { external: ['sharp'] },
	define: {
		__BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
		__BUILD_SHA__: JSON.stringify(BUILD_SHA),
		__BUILD_TS__: JSON.stringify(BUILD_TS)
	},
	server: {
		host: '0.0.0.0',
		port: 18769,
		strictPort: true,
		allowedHosts: true
	},
	preview: {
		host: '0.0.0.0',
		port: 18769,
		strictPort: true,
		allowedHosts: true
	}
});
