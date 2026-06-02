<script lang="ts">
	// Chat header — sidebar-toggle + home-anchor logo only.
	//
	// As of 2026-06-02 the workspace-context chip and the model-picker chip
	// (with its sheet/popover) were relocated OUT of the header and INTO the
	// composer. Operator rationale: "the button should move where the text
	// area is. since it is closer to the sheet" — the sheet anchors to the
	// viewport bottom on mobile, so the trigger belongs near the composer
	// for thumb proximity. Desktop dropdown now blooms UPWARD from the chip
	// (the chip lives next to the composer, the dropdown opens above it).
	//
	// All picker / context plumbing now lives in Composer.svelte:
	//   - showModelOverrideModal / workspaceContextOpen bindable state
	//   - onsetModelChoice / onopenWorkspaceContext / oncloseAllPopovers callbacks
	//   - MODEL_CHOICES / selectedModelChoice / tierEmoji / lastModelUsed inputs
	//   - The mobilePortal action + sheetTransition function
	//
	// The header keeps its existing ARIA labels (`Toggle Sessions Sidebar`,
	// `Sully — home`) — load-bearing for the chat e2e suite.

	import { base, resolve } from '$app/paths';
	import { Menu } from 'lucide-svelte';

	let {
		ontoggleSidebar
	}: {
		ontoggleSidebar: () => void;
	} = $props();
</script>

<header
	class="relative z-50 flex shrink-0 items-center gap-2 border-b border-white/[0.05] bg-[#0b0b0d]/55 px-4 pt-3 pb-2 backdrop-blur-2xl select-none"
	style="padding-top: max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem));"
>
	<!-- Sidebar toggle button (mobile-only — desktop sidebar is persistent) -->
	<button
		type="button"
		onclick={ontoggleSidebar}
		class="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.03] text-zinc-400 transition-all hover:bg-white/[0.07] hover:text-white active:scale-90 sm:h-9 sm:w-9 lg:hidden"
		aria-label="Toggle Sessions Sidebar"
		title="Toggle Sessions Sidebar"
	>
		<Menu size={16} />
	</button>

	<!-- Sully identity — her glossy "thought-drop" face + name -->
	<a
		href={resolve('/')}
		aria-label="Sully — home"
		class="ml-0.5 flex items-center gap-2 transition-opacity hover:opacity-80"
	>
		<img
			src="{base}/sully-mark.png"
			alt=""
			class="h-8 w-8 shrink-0 drop-shadow-[0_0_10px_rgba(236,45,120,0.5)]"
		/>
		<span class="font-sans text-sm font-semibold tracking-tight text-zinc-100">Sully</span>
	</a>
</header>
