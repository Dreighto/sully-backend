import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	define: {
		__BUILD_VERSION__: JSON.stringify('test'),
		__BUILD_SHA__: JSON.stringify('test-sha')
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts']
	}
});
