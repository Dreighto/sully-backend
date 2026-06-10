<script lang="ts">
	import { toasts } from '$lib/utils/toasts';
	import { flip } from 'svelte/animate';
	import { fly } from 'svelte/transition';
	import { Info, CheckCircle2, AlertTriangle, AlertCircle, X } from 'lucide-svelte';

	const icons = {
		info: Info,
		success: CheckCircle2,
		warning: AlertTriangle,
		error: AlertCircle
	};

	// Status-colored TINTED background + neutral readable text + status-colored
	// icon + border. The previous palette set background AND text to the same
	// status color, rendering the message invisible (red text on a red panel —
	// surfaced during the 2026-05-27 audit as "empty red bars on mic failure").
	const panel = {
		info: 'bg-zinc-950/90 border-zinc-800/80',
		success: 'bg-status-green/[0.08] border-status-green/40',
		warning: 'bg-status-amber/[0.08] border-status-amber/40',
		error: 'bg-status-red/[0.08] border-status-red/40'
	};
	const iconColor = {
		info: 'text-zinc-300',
		success: 'text-status-green',
		warning: 'text-status-amber',
		error: 'text-status-red'
	};
</script>

<!-- Toast stack — pushed below the Dynamic Island via safe-area-inset-top.
     Capped at 320px on mobile so they don't eat the full width. -->
<div
	class="pointer-events-none fixed left-1/2 z-[100] flex w-full max-w-xs -translate-x-1/2 flex-col gap-1.5 px-3 sm:max-w-[400px] sm:gap-2 sm:px-4"
	style="top: calc(env(safe-area-inset-top, 0px) + 8px)"
>
	{#each $toasts as toast (toast.id)}
		{@const Icon = icons[toast.type]}
		<div
			animate:flip={{ duration: 250 }}
			in:fly={{ y: -16, duration: 250 }}
			out:fly={{ y: -16, duration: 180 }}
			data-toast
			data-toast-type={toast.type}
			class="pointer-events-auto flex items-start gap-2.5 rounded-[var(--r-sm)] border p-2.5 text-zinc-100 shadow-[var(--shadow-card)] backdrop-blur-md sm:p-3 {panel[
				toast.type
			]}"
		>
			<Icon size={16} class="mt-0.5 shrink-0 {iconColor[toast.type]}" aria-hidden="true" />
			<div class="flex-1 text-xs leading-snug font-medium sm:text-sm">
				{toast.message}
			</div>
			<button
				type="button"
				onclick={() => toasts.remove(toast.id)}
				aria-label="Dismiss notification"
				class="shrink-0 rounded-[var(--r-xs)] p-1 text-zinc-400 opacity-60 transition-opacity hover:opacity-100"
			>
				<X size={12} aria-hidden="true" />
			</button>
		</div>
	{/each}
</div>
