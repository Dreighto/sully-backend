<script lang="ts">
	// Chat header — sidebar-toggle + home-anchor logo + workspace-context
	// icon button on the right.
	//
	// History:
	//   - 2026-06-01: relocated model picker + context chips OUT of header
	//     into the composer (operator: "closer to the sheet").
	//   - 2026-06-02 (later): operator wanted model picker INSIDE the pill
	//     and context "moved somewhere else" — context moves BACK to the
	//     header as a small BookOpen icon on the right, the model picker
	//     stays in the composer pill. Header now reads as identity (left)
	//     + workspace settings entry (right).
	//
	// The context icon is a single tap to the same WorkspaceContextModal
	// the old footer entry used to open. `workspaceContextOpen` is bindable
	// so the parent's global popover-close $effect can null it; drives the
	// icon's brand-pink active treatment while the modal is open.

	import { base, resolve } from '$app/paths';
	import { PanelLeft, BookOpen } from 'lucide-svelte';

	let {
		workspaceContextOpen = $bindable(false),
		ontoggleSidebar,
		onopenWorkspaceContext
	}: {
		workspaceContextOpen?: boolean;
		ontoggleSidebar: () => void;
		onopenWorkspaceContext: () => void;
	} = $props();
</script>

<header
	class="relative z-50 flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.05] bg-[#0b0b0d]/55 px-4 pt-3 pb-2 backdrop-blur-2xl select-none"
	style="padding-top: max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem));"
>
	<!-- Left cluster: sidebar toggle (mobile-only) + Sully identity. -->
	<div class="flex shrink-0 items-center gap-1.5">
		<button
			type="button"
			onclick={ontoggleSidebar}
			class="flex h-11 w-11 items-center justify-center rounded-[var(--r-pill)] text-zinc-400 transition-all hover:bg-white/[0.06] hover:text-white active:scale-90 sm:h-9 sm:w-9 lg:hidden"
			aria-label="Toggle Sessions Sidebar"
			title="Toggle Sessions Sidebar"
		>
			<PanelLeft size={16} />
		</button>

		<a
			href={resolve('/')}
			aria-label="Sully — home"
			class="ml-0.5 flex items-center gap-2 transition-opacity hover:opacity-80"
		>
			<img
				src="{base}/sully-mark.png"
				alt=""
				class="h-8 w-8 shrink-0 drop-shadow-[0_0_10px_var(--accent-glow)]"
			/>
			<span class="font-sans text-sm font-semibold tracking-tight text-zinc-100">Sully</span>
		</a>
	</div>

	<!-- Right: workspace-context entry. Icon-only on both viewports —
	     reads as a settings affordance rather than a primary action.
	     Active state mirrors the model-picker open recipe so when the
	     modal is open the icon glows in the same idiom. -->
	<button
		type="button"
		onclick={() => onopenWorkspaceContext()}
		class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--r-pill)] transition-all active:scale-90 sm:h-9 sm:w-9 {workspaceContextOpen
			? 'bg-white/10 text-white'
			: 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'}"
		aria-label="Sully's workspace context"
		aria-haspopup="dialog"
		aria-expanded={workspaceContextOpen}
		title="Edit the notes Sully sees on every message"
	>
		<BookOpen size={16} aria-hidden="true" />
	</button>
</header>
