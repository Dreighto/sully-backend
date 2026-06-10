<script lang="ts">
	let {
		worker,
		brief,
		onapprove,
		onskip,
		onedit
	}: {
		worker: string;
		brief: string;
		onapprove: () => void;
		onskip: () => void;
		onedit: (brief: string) => void;
	} = $props();

	let editing = $state(false);
	let draft = $state(brief);
</script>

<div class="rounded-[var(--r-lg)] border border-fuchsia-400/25 bg-fuchsia-950/10 px-4 py-3">
	<div class="text-[12px] text-fuchsia-200/90">
		Sully wants to send this to <strong>{worker === 'claude-code' ? 'CC' : 'AGY'}</strong>
	</div>
	{#if editing}
		<textarea
			class="mt-2 w-full rounded-[var(--r-sm)] border border-fuchsia-400/20 bg-black/30 p-2 text-[12px] text-fuchsia-100"
			bind:value={draft}
			rows="2"
		></textarea>
	{:else}
		<div class="mt-1 text-[12px] text-fuchsia-100/70">{brief}</div>
	{/if}
	<div class="mt-2 flex gap-2">
		<button
			class="rounded-[var(--r-pill)] bg-fuchsia-500/90 px-3 py-1 text-[12px] text-white transition-all active:scale-95"
			onclick={() => (editing ? onedit(draft) : onapprove())}
		>
			{editing ? 'Send edited' : 'Approve'}
		</button>
		<button
			class="rounded-[var(--r-pill)] border border-fuchsia-400/30 px-3 py-1 text-[12px] text-fuchsia-200 transition-all active:scale-95"
			onclick={onskip}
		>
			Skip
		</button>
		{#if !editing}
			<button
				class="rounded-[var(--r-pill)] border border-fuchsia-400/30 px-3 py-1 text-[12px] text-fuchsia-200 transition-all active:scale-95"
				onclick={() => (editing = true)}
			>
				Edit brief
			</button>
		{/if}
	</div>
</div>
