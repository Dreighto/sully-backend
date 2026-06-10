<script lang="ts">
	// Full-viewport image preview overlay. Mounted at the chat page root and
	// fed from Markdown.svelte's per-image click handler. Tap-scrim /
	// X-button / Escape all close. Pinch-zoom is handled natively by the
	// browser's image-as-content treatment — we don't reinvent it.
	//
	// Why a dedicated component (vs CSS modal hack on the existing <img>):
	// in-feed images are constrained by Markdown.svelte's max-width:100% +
	// max-height:60vh. Operator's 2026-06-02 feedback: "no way of previewing
	// the image generated besides looking at the small box the image was
	// generated in." Tap-to-expand into a separate layer gives a real look.
	import { X, Share2 } from 'lucide-svelte';
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { shareImage } from '$lib/utils/share-image';

	let {
		src,
		alt = '',
		onclose
	}: {
		src: string | null;
		alt?: string;
		onclose: () => void;
	} = $props();

	let saving = $state(false);

	async function onSave() {
		if (!src || saving) return;
		saving = true;
		try {
			await shareImage(src, alt || 'Image from Sully');
		} finally {
			saving = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	$effect(() => {
		if (!src) return;
		document.addEventListener('keydown', onKey);
		// Lock body scroll while open — otherwise tap-and-drag on iOS leaks
		// to the chat feed scroll behind the overlay.
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.removeEventListener('keydown', onKey);
			document.body.style.overflow = prevOverflow;
		};
	});
</script>

{#if src}
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Image preview"
		class="fixed inset-0 z-[100] flex items-center justify-center bg-black/92 backdrop-blur-xl"
		onclick={() => onclose()}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') onclose();
		}}
		tabindex="-1"
		transition:fade={{ duration: 180 }}
	>
		<!-- Image. Stop-propagation so taps on the image itself don't dismiss
		     — only the surrounding scrim does. The X button is the explicit
		     close affordance for users who don't tap the scrim. -->
		<img
			{src}
			{alt}
			onclick={(e) => e.stopPropagation()}
			class="max-h-[92vh] max-w-[94vw] rounded-[var(--r-sm)] object-contain shadow-[var(--shadow-float)]"
			style="touch-action: pinch-zoom;"
			transition:scale={{ duration: 220, easing: cubicOut, start: 0.96 }}
		/>

		<!-- Top-right close + download cluster. Outside the image's click-zone
		     so they dismiss / download cleanly without ambiguity. -->
		<div
			class="fixed top-0 right-0 z-[101] flex items-center gap-2 p-4"
			style="padding-top: max(1rem, env(safe-area-inset-top, 0px));"
		>
			<!-- iOS Safari/WebKit silently ignores the `download` attribute on
			     anchors — tapping a `<a href download>` would navigate the
			     WebView to the image URL itself, stranding the operator on
			     a bare image page with no back button (verified 2026-06-02).
			     The Share API opens the native share sheet on iOS (Save
			     Image, Save to Files, AirDrop) and falls back to a real
			     anchor-download on web. See share-image.ts. -->
			<button
				type="button"
				onclick={(e) => {
					e.stopPropagation();
					void onSave();
				}}
				disabled={saving}
				class="flex h-11 w-11 items-center justify-center rounded-[var(--r-pill)] bg-white/[0.08] text-zinc-200 backdrop-blur-md transition-all hover:bg-white/[0.16] active:scale-90 disabled:opacity-50"
				aria-label="Save image"
				title="Save / Share"
			>
				<Share2 size={18} />
			</button>
			<button
				type="button"
				onclick={(e) => {
					e.stopPropagation();
					onclose();
				}}
				class="flex h-11 w-11 items-center justify-center rounded-[var(--r-pill)] bg-white/[0.08] text-zinc-200 backdrop-blur-md transition-all hover:bg-white/[0.16] active:scale-90"
				aria-label="Close preview"
				title="Close"
			>
				<X size={18} />
			</button>
		</div>
	</div>
{/if}
