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

<!-- Companion is chat-only: full-bleed immersive shell, no Console chrome/nav. -->
<div class="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
	{@render children()}
	<ToastContainer />
	<PwaUpdatePrompt />
</div>
