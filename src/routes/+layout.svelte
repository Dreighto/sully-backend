<script lang="ts">
	import { base } from '$app/paths';
	import { onNavigate } from '$app/navigation';
	import PwaUpdatePrompt from '$lib/components/PwaUpdatePrompt.svelte';
	import ToastContainer from '$lib/components/ToastContainer.svelte';
	import '../app.css';

	let { children } = $props();

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

<!-- Living aurora — the app's animated magenta background, behind all content. -->
<div class="app-aurora" aria-hidden="true">
	<span class="a1"></span><span class="a2"></span><span class="a3"></span>
</div>

<!-- Companion is chat-only: full-bleed immersive shell, no Console chrome/nav. -->
<div class="relative z-[1] flex h-[100dvh] flex-col overflow-hidden text-foreground">
	{@render children()}
	<ToastContainer />
	<PwaUpdatePrompt />
</div>
