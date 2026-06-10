<script lang="ts">
	import type { StreamRow } from '$lib/chat/dispatchReconcile';
	import { friendlyStep, isTerminalStatus, isSuccessStatus } from '$lib/dispatchActivityView';

	let {
		worker,
		rows,
		status,
		durationLabel,
		onretry
	}: {
		worker: string;
		rows: StreamRow[];
		status: string;
		durationLabel: string | null;
		onretry?: () => void;
	} = $props();

	const who = $derived(worker === 'gemini' ? 'AGY' : 'CC');
	const last = $derived(rows.length ? rows[rows.length - 1] : null);
	// Only ever show a mapped plain-English step — raw actions/targets/JSON never
	// reach this component, but map defensively anyway.
	const stepLine = $derived(last ? friendlyStep(last.action, last.target) : null);
	const working = $derived(!isTerminalStatus(status));
	const succeeded = $derived(isTerminalStatus(status) && isSuccessStatus(status));
</script>

{#if working}
	<!-- Live: a calm pulse + a friendly status line. NO timer (the stuck "39:53"
	     was a live clock; we never show digits while working). -->
	<div
		class="flex flex-col gap-1 rounded-[var(--r-lg)] border border-fuchsia-400/25 bg-fuchsia-950/15 px-4 py-3 backdrop-blur-md"
		role="status"
		aria-label="{who} is working"
	>
		<div class="flex items-center gap-2">
			<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-[var(--r-pill)] bg-fuchsia-400"
			></span>
			<span class="text-[12px] font-medium tracking-wide text-fuchsia-200">{who} is on it</span>
		</div>
		{#if stepLine}
			<div class="text-[11px] text-fuchsia-200/70">{stepLine}</div>
		{/if}
	</div>
{:else if succeeded}
	<!-- Resolved: a compact strip that sits flush above Sully's plain-English
	     answer so the two read as one unit. Frozen duration — never counts up. -->
	<div
		class="inline-flex items-center gap-1.5 rounded-[var(--r-pill)] border border-emerald-400/20 bg-emerald-950/10 px-3 py-1 text-[11px] text-emerald-200/80"
	>
		<span aria-hidden="true">✓</span>
		<span>{who} handled this{durationLabel ? ` · ${durationLabel}` : ''}</span>
	</div>
{:else}
	<!-- Failed / aborted: blame-free, with an optional one-tap retry. -->
	<div
		class="flex items-center gap-2 rounded-[var(--r-lg)] border border-rose-400/25 bg-rose-950/15 px-4 py-2 text-[12px] text-rose-200/85"
	>
		<span
			>{status === 'aborted'
				? `${who} stopped before finishing`
				: `${who} ran into a problem`}</span
		>
		{#if onretry}
			<button
				class="ml-1 rounded-[var(--r-xs)] px-2 py-1 font-medium underline hover:bg-white/5"
				onclick={onretry}
			>
				Try again
			</button>
		{/if}
	</div>
{/if}
