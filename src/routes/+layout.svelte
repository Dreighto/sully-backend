<script lang="ts">
	import { base } from '$app/paths';
	import { onNavigate } from '$app/navigation';
	import { onMount } from 'svelte';
	import PwaUpdatePrompt from '$lib/components/PwaUpdatePrompt.svelte';
	import ToastContainer from '$lib/components/ToastContainer.svelte';
	import { initNativePush } from '$lib/native/push';
	// Self-hosted Blend Mk II faces (locked spec v1.0 Section 4 Option A). Vite
	// bundles the woff2 into the build and Capacitor packages them into the IPA,
	// so Sully renders identically offline with zero Google Fonts requests.
	import '@fontsource-variable/fraunces';
	import '@fontsource-variable/bricolage-grotesque';
	import '@fontsource-variable/jetbrains-mono';
	import '../app.css';

	let { children } = $props();

	// Register for native iOS push on app start. No-op on web / PWA — the module
	// guards on Capacitor.isNativePlatform() internally. Best-effort; never blocks.
	onMount(() => {
		void initNativePush();
	});

	// Smooth cross-page view transitions (progressive enhancement; no-op where unsupported).
	onNavigate((navigation) => {
		if (!document.startViewTransition) return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
</script>

<svelte:head>
	<link rel="manifest" href="{base}/manifest.webmanifest" />
</svelte:head>

<!-- Ambient Indigo wash — fixed, paint-isolated shell layer behind all content
     (locked spec v1.0 Section 3; magenta retired). -->
<div class="app-bg" aria-hidden="true"></div>

<!-- Companion is chat-only: full-bleed immersive shell, no Console chrome/nav. -->
<div class="relative z-[1] flex h-[100dvh] flex-col overflow-hidden text-foreground">
	{@render children()}
	<ToastContainer />
	<PwaUpdatePrompt />
</div>
